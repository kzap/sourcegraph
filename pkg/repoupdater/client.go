package repoupdater

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io/ioutil"
	"net/http"

	"github.com/opentracing-contrib/go-stdlib/nethttp"
	opentracing "github.com/opentracing/opentracing-go"
	"github.com/opentracing/opentracing-go/ext"
	"github.com/pkg/errors"
	"github.com/sourcegraph/sourcegraph/pkg/api"
	"github.com/sourcegraph/sourcegraph/pkg/env"
	"github.com/sourcegraph/sourcegraph/pkg/gitserver"
	"github.com/sourcegraph/sourcegraph/pkg/repoupdater/protocol"
)

var repoupdaterURL = env.Get("REPO_UPDATER_URL", "http://repo-updater:3182", "repo-updater server URL")

var (
	// ErrNotFound is when a repository is not found.
	ErrNotFound = errors.New("repository not found")

	// ErrUnauthorized is when an authorization error occurred.
	ErrUnauthorized = errors.New("not authorized")

	// ErrTemporarilyUnavailable is when the repository was reported as being temporarily
	// unavailable.
	ErrTemporarilyUnavailable = errors.New("repository temporarily unavailable")
)

// DefaultClient is the default Client. Unless overwritten, it is connected to the server specified by the
// REPO_UPDATER_URL environment variable.
var DefaultClient = &Client{
	URL: repoupdaterURL,
	HTTPClient: &http.Client{
		// nethttp.Transport will propagate opentracing spans
		Transport: &nethttp.Transport{
			RoundTripper: &http.Transport{
				// Default is 2, but we can send many concurrent requests
				MaxIdleConnsPerHost: 500,
			},
		},
	},
}

// Client is a repoupdater client.
type Client struct {
	// URL to repoupdater server.
	URL string

	// HTTP client to use
	HTTPClient *http.Client
}

// RepoUpdateSchedulerInfo returns information about the state of the repo in the update scheduler.
func (c *Client) RepoUpdateSchedulerInfo(ctx context.Context, args protocol.RepoUpdateSchedulerInfoArgs) (result *protocol.RepoUpdateSchedulerInfoResult, err error) {
	resp, err := c.httpPost(ctx, "repo-update-scheduler-info", args)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		stack := fmt.Sprintf("RepoScheduleInfo: %+v", args)
		return nil, errors.Wrap(fmt.Errorf("http status %d", resp.StatusCode), stack)
	}
	defer resp.Body.Close()
	err = json.NewDecoder(resp.Body).Decode(&result)
	return result, err
}

// MockRepoLookup mocks (*Client).RepoLookup for tests.
var MockRepoLookup func(protocol.RepoLookupArgs) (*protocol.RepoLookupResult, error)

// RepoLookup retrieves information about the repository on repoupdater.
func (c *Client) RepoLookup(ctx context.Context, args protocol.RepoLookupArgs) (result *protocol.RepoLookupResult, err error) {
	if MockRepoLookup != nil {
		return MockRepoLookup(args)
	}

	span, ctx := opentracing.StartSpanFromContext(ctx, "Client.RepoLookup")
	defer func() {
		if result != nil {
			span.SetTag("found", result.Repo != nil)
		}
		if err != nil {
			ext.Error.Set(span, true)
			span.SetTag("err", err.Error())
		}
		span.Finish()
	}()
	if args.ExternalRepo != nil {
		span.SetTag("ExternalRepo.ID", args.ExternalRepo.ID)
		span.SetTag("ExternalRepo.ServiceType", args.ExternalRepo.ServiceType)
		span.SetTag("ExternalRepo.ServiceID", args.ExternalRepo.ServiceID)
	}
	if args.Repo != "" {
		span.SetTag("Repo", string(args.Repo))
	}

	resp, err := c.httpPost(ctx, "repo-lookup", args)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	stack := fmt.Sprintf("RepoLookup: %+v", args)
	if resp.StatusCode != http.StatusOK {
		return nil, errors.Wrap(fmt.Errorf("http status %d", resp.StatusCode), stack)
	}

	err = json.NewDecoder(resp.Body).Decode(&result)
	if err == nil && result != nil {
		switch {
		case result.ErrorNotFound:
			err = ErrNotFound
		case result.ErrorUnauthorized:
			err = ErrUnauthorized
		case result.ErrorTemporarilyUnavailable:
			err = ErrTemporarilyUnavailable
		}
	}
	return result, err
}

// Repo represents a repository on gitserver. It contains the information necessary to identify and
// create/clone it.
type Repo struct {
	Name api.RepoName // the repository's URI

	// URL is the repository's Git remote URL. If the gitserver already has cloned the repository,
	// this field is optional (it will use the last-used Git remote URL). If the repository is not
	// cloned on the gitserver, the request will fail.
	URL string
}

// MockEnqueueRepoUpdate mocks (*Client).EnqueueRepoUpdate for tests.
var MockEnqueueRepoUpdate func(ctx context.Context, repo gitserver.Repo) (*protocol.RepoUpdateResponse, error)

// EnqueueRepoUpdate requests that the named repository be updated in the near
// future. It does not wait for the update.
func (c *Client) EnqueueRepoUpdate(ctx context.Context, repo gitserver.Repo) (*protocol.RepoUpdateResponse, error) {
	if MockEnqueueRepoUpdate != nil {
		return MockEnqueueRepoUpdate(ctx, repo)
	}

	req := &protocol.RepoUpdateRequest{
		Repo: repo.Name,
		URL:  repo.URL,
	}

	resp, err := c.httpPost(ctx, "enqueue-repo-update", req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	bs, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return nil, errors.Wrap(err, "failed to read response body")
	}

	var res protocol.RepoUpdateResponse
	if resp.StatusCode < 200 || resp.StatusCode >= 400 {
		return nil, errors.New(string(bs))
	} else if err = json.Unmarshal(bs, &res); err != nil {
		return nil, err
	}

	return &res, nil
}

// SyncExternalService requests the given external service to be synced.
func (c *Client) SyncExternalService(ctx context.Context, svc api.ExternalService) (*protocol.ExternalServiceSyncResult, error) {
	req := &protocol.ExternalServiceSyncRequest{ExternalService: svc}
	resp, err := c.httpPost(ctx, "sync-external-service", req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	bs, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return nil, errors.Wrap(err, "failed to read response body")
	}

	var result protocol.ExternalServiceSyncResult
	if resp.StatusCode < 200 || resp.StatusCode >= 400 {
		// TODO(tsenart): Use response type for unmarshalling errors too.
		// This needs to be done after rolling out the response type in prod.
		return nil, errors.New(string(bs))
	} else if len(bs) == 0 {
		// TODO(keegancsmith): Remove once repo-updater update is rolled out.
		result.ExternalService = svc
		return &result, nil
	} else if err = json.Unmarshal(bs, &result); err != nil {
		return nil, err
	}

	return &result, nil
}

// RepoExternalServices requests the external services associated with a
// repository with the given id.
func (c *Client) RepoExternalServices(ctx context.Context, id uint32) ([]api.ExternalService, error) {
	req := protocol.RepoExternalServicesRequest{ID: id}
	resp, err := c.httpPost(ctx, "repo-external-services", &req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	bs, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return nil, errors.Wrap(err, "failed to read response body")
	}

	var res protocol.RepoExternalServicesResponse
	if resp.StatusCode < 200 || resp.StatusCode >= 400 {
		return nil, errors.New(string(bs))
	} else if err = json.Unmarshal(bs, &res); err != nil {
		return nil, err
	}

	return res.ExternalServices, nil
}

// ExcludeRepo adds the repository with the given id to all of the
// external services exclude lists that match its kind.
func (c *Client) ExcludeRepo(ctx context.Context, id uint32) (*protocol.ExcludeRepoResponse, error) {
	if id == 0 {
		return &protocol.ExcludeRepoResponse{}, nil
	}

	req := protocol.ExcludeRepoRequest{ID: id}
	resp, err := c.httpPost(ctx, "exclude-repo", &req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	bs, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return nil, errors.Wrap(err, "failed to read response body")
	}

	var res protocol.ExcludeRepoResponse
	if resp.StatusCode < 200 || resp.StatusCode >= 400 {
		return nil, errors.New(string(bs))
	} else if err = json.Unmarshal(bs, &res); err != nil {
		return nil, err
	}

	return &res, nil
}

func (c *Client) httpPost(ctx context.Context, method string, payload interface{}) (resp *http.Response, err error) {
	span, ctx := opentracing.StartSpanFromContext(ctx, "Client.httpPost")
	defer func() {
		if err != nil {
			ext.Error.Set(span, true)
			span.SetTag("err", err.Error())
		}
		span.Finish()
	}()

	reqBody, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest("POST", c.URL+"/"+method, bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
	}

	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(ctx)
	req, ht := nethttp.TraceRequest(span.Tracer(), req,
		nethttp.OperationName("RepoUpdater Client"),
		nethttp.ClientTrace(false))
	defer ht.Finish()

	if c.HTTPClient != nil {
		return c.HTTPClient.Do(req)
	}
	return http.DefaultClient.Do(req)
}
