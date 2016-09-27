import * as throttle from "lodash/throttle";
import * as React from "react";
import {InjectedRouter} from "react-router";

import {EventListener} from "sourcegraph/Component";
import {Input} from "sourcegraph/components/Input";
import {Search as SearchIcon} from "sourcegraph/components/symbols";
import {colors} from "sourcegraph/components/utils/index";

import {urlToBlob, urlToBlobLine} from "sourcegraph/blob/routes";
import * as Dispatcher from "sourcegraph/Dispatcher";
import * as RepoActions from "sourcegraph/repo/RepoActions";
import {RepoStore} from "sourcegraph/repo/RepoStore";
import * as TreeActions from "sourcegraph/tree/TreeActions";
import {TreeStore} from "sourcegraph/tree/TreeStore";
import "string_score";

import {Hint, ResultCategories} from "sourcegraph/quickopen/Components";

import * as AnalyticsConstants from "sourcegraph/util/constants/AnalyticsConstants";
import {EventLogger} from "sourcegraph/util/EventLogger";

const modalStyle = {
	position: "fixed",
	top: 0,
	right: 0,
	left: 0,
	maxWidth: 515,
	margin: "0 auto",
	borderRadius: "0 0 3px 3px",
	backgroundColor: colors.coolGray2(),
	padding: 16,
	display: "flex",
	flexDirection: "column",
	zIndex: 4,
	maxHeight: "90vh",
	fontSize: "1rem",
	boxShadow: `0 2px 4px 0 ${colors.black(.1)}`,
};

export interface Result {
	title: string;
	description: string;
	index?: number;  // Index of the matched segment.
	length?: number; // Length of the matched segment.

	// The URL to the result.
	URLPath: string;
};

interface Props {
	dismissModal: (resultSubmitted?: boolean) => void;
	repo: null | {
		URI: string;
		rev: string | null;
	};
};

interface State {
	// The search string in the input box.
	input: string;
	// The row and category that a user has navigated to using a keyboard.
	selected: {
		category: number;
		row: number;
	};
	// Number of results to show in each category.
	limitForCategory: number[];
	// The results of the search.
	results: Category[];
	// Whether or not to allow scrolling. Used to prevent jumping when expanding
	// a category.
	allowScroll: boolean;
	// Resolved repository commitID.
	commitID: string | null;
};

export interface Category {
	Title: string;
	Results?: Result[];
	IsLoading: boolean;
}

export interface SearchDelegate {
	dismiss: any;
	select: (category: number, row: number) => void;
	expand: (category: number) => void;
}

// SearchContainer contains the logic that deals with navigation and data
// fetching.
export class Container extends React.Component<Props, State> {

	static contextTypes: any = {
		router: React.PropTypes.object.isRequired,
	};

	context: { router: InjectedRouter };
	searchInput: HTMLElement;
	delegate: SearchDelegate;
	listeners: {remove: () => void}[];

	constructor(props: Props) {
		super(props);
		this.keyListener = this.keyListener.bind(this);
		this.bindSearchInput = this.bindSearchInput.bind(this);
		this.updateInput = this.updateInput.bind(this);
		this.updateResults = throttle(this.updateResults.bind(this), 150, {leading: true, trailing: true});
		this.fetchResults = throttle(this.fetchResults, 150, {leading: true, trailing: true});
		this.state = {
			input: "",
			selected: {category: 0, row: 0},
			limitForCategory: [3, 3, 3],
			results: [],
			allowScroll: true,
			commitID: null,
		};
		this.delegate = {
			dismiss: props.dismissModal,
			select: this.select.bind(this),
			expand: this.expand.bind(this),
		};
	}

	componentDidMount(): void {
		this.listeners = [
			TreeStore.addListener(this.updateResults),
			RepoStore.addListener(this.updateResults),
		];
		if (this.props.repo) {
			const r = RepoStore.resolvedRevs.get(this.props.repo.URI, this.props.repo.rev);
			this.setState(Object.assign({}, this.state, {commitID: r.CommitID}));
		}
		setTimeout(() =>  {
			this.fetchResults();
			this.updateResults();
		});
	}

	componentWillUnmount(): void {
		this.listeners.forEach(s => { s.remove(); });
	}

	componentWillUpdate(_: Props, nextState: State): void {
		if (nextState.input !== this.state.input) {
			nextState.limitForCategory = [3, 3, 3];
			nextState.selected = {category: 0, row: 0};
		}
	}

	componentDidUpdate(_: Props, prevState: State): void {
		if (this.state.input !== prevState.input) {
			this.fetchResults();
			this.updateResults();
		}
	}

	keyListener(event: KeyboardEvent): void {
		const results = this.state.results;
		const visibleRowsInCategory = results.map((r, i) => r.Results ? Math.min(r.Results.length, this.state.limitForCategory[i]) : 0);
		let category = this.state.selected.category;
		let row = this.state.selected.row;
		const nextVisibleRow = direction => {
			let next = category;
			for (let i = 0; i < results.length; i++) {
				next += direction;
				if (visibleRowsInCategory[next] > 0) {
					return next;
				}
			}
			return category;
		};
		if (event.key === "ArrowUp") {
			if (row === 0 && category === 0) {
				// noop
			} else if (row <= 0) {
				category = nextVisibleRow(-1);
				row = visibleRowsInCategory[category] - 1;
			} else {
				row--;
			}
		} else if (event.key === "ArrowDown") {
			if (row === visibleRowsInCategory[category] - 1 && category === results.length - 1) {
				// noop
			} else if (row >= visibleRowsInCategory[category] - 1) {
				const next = nextVisibleRow(1);
				row = next === category ? row : 0;
				category = next;
			} else {
				row++;
			}
		} else if (event.key === "Enter") {
			this.select(this.state.selected.category, this.state.selected.row);
		} else {
			return;
		}
		let state = Object.assign(this.state, {
			selected: {category: category, row: row},
			allowScroll: true,
		});
		this.setState(state);
		event.preventDefault();
	}

	fetchResults(): void {
		const query = this.state.input;
		Dispatcher.Backends.dispatch(new RepoActions.WantRepos(this.repoListQueryString(query)));
		if (this.props.repo !== null && this.state.commitID)  {
			const rev = this.props.repo.rev || "";
			Dispatcher.Backends.dispatch(new RepoActions.WantSymbols(this.props.repo.URI, rev, query));
			Dispatcher.Backends.dispatch(new TreeActions.WantFileList(this.props.repo.URI, this.state.commitID));
		}
	}

	repoListQueryString(query: string): string {
		return `Query=${encodeURIComponent(query)}&Type=public`;
	}

	updateInput(event: React.FormEvent<HTMLInputElement>): void {
		const input = (event.target as any).value;
		const state = Object.assign({}, this.state, {
			input: input,
		});
		this.setState(state);
	}

	select(c: number, r: number): void {
		const results = this.state.results[c];
		if (results && results.Results) {
			const result = results.Results[r];
			const resultInfo = {
				category: c,
				rankInCategory: r,
			};
			Object.assign(resultInfo, result);
			const eventProps = {
				repo: this.props.repo,
				quickOpenResult: resultInfo,
				quickOpenQuery: this.state.input,
			};
			EventLogger.logEventForCategory(AnalyticsConstants.CATEGORY_QUICK_OPEN, AnalyticsConstants.ACTION_CLICK, "QuickOpenItemSelected", eventProps);
			const url = result.URLPath;
			this.props.dismissModal(true);
			this.context.router.push(url);
		}
	}

	bindSearchInput(node: HTMLElement): void { this.searchInput = node; }

	updateResults(): void {
		const query = this.state.input.toLowerCase();
		const results: Category[] = [];
		const repo = this.props.repo;

		if (repo) {
			const symbols = RepoStore.symbols.list(repo.URI, repo.rev, query);
			if (symbols) {
				const symbolResults: Result[] = [];
				symbols.forEach(sym => {
					let title = sym.name;
					const kind = symbolKindName(sym.kind);
					const desc = `${kind ? kind : ""} in ${sym.location.uri}`;
					let idx = title.toLowerCase().indexOf(query);
					const path = sym.location.uri;
					const line = sym.location.range.start.line;
					symbolResults.push({
						title: title,
						description: desc,
						index: idx,
						length: query.length,
						URLPath: urlToBlobLine(repo.URI, repo.rev, path, line + 1),
					});
				});
				results.push({ Title: "Definitions", IsLoading: false, Results: symbolResults });
			} else {
				results.push({ Title: "Definitions", IsLoading: true });
			}

			const commit = this.state.commitID || "";
			const files = TreeStore.fileLists.get(repo.URI, commit);
			if (files) {
				interface Scorable {
					score: number;
				}
				let fileResults: (Result & Scorable)[] = files.Files.reduce((acc, file) => rankFile(acc, file, query), []);
				fileResults.forEach(file => {
					file.URLPath = urlToBlob(repo.URI, repo.rev, file.title);
				});
				fileResults = fileResults.sort((a, b) => b.score - a.score);
				results.push({ Title: "Files", IsLoading: false, Results: fileResults });
			} else {
				results.push({ Title: "Files", IsLoading: true });
			}
		}

		const repos = RepoStore.repos.list(this.repoListQueryString(query));
		if (repos) {
			if (repos.Repos) {
				const repoResults = repos.Repos.map(({URI}) => ({title: URI, URLPath: `/${URI}`}));
				results.push({ Title: "Repositories", IsLoading: false, Results: repoResults });
			} else {
				results.push({ Title: "Repositories", IsLoading: false, Results: [] });
			}
		} else {
			results.push({ Title: "Repositories", IsLoading: true });
		}

		this.setState(Object.assign({}, this.state, {results: results}));
	}

	expand(category: number): () => void {
		return () => {
			const state = Object.assign({}, this.state);
			state.limitForCategory[category] += 12;
			state.allowScroll = false;
			this.setState(state);
			if (this.searchInput) {
				this.searchInput.focus();
			}
		};
	}

	render(): JSX.Element {
		return (
			<div style={modalStyle}>
				<EventListener target={document.body} event={"keydown"} callback={this.keyListener} />
				<div style={{
					backgroundColor: colors.white(),
					borderRadius: 3,
					width: "100%",
					padding: "3px 10px",
					flex: "0 0 auto",
					height: 45,
					display: "flex",
					alignItems: "center",
					flexDirection: "row",
				}}>
					<SearchIcon style={{fill: colors.coolGray2()}} />
					<Input
						style={{boxSizing: "border-box", border: "none", flex: "1 0 auto"}}
						placeholder="Search for repositories, files or definitions"
						value={this.state.input}
						block={true}
						autoFocus={true}
						domRef={this.bindSearchInput}
						onChange={this.updateInput} />
				</div>
				<Hint />
				<ResultCategories categories={this.state.results}
					selection={this.state.selected}
					delegate={this.delegate}
					scrollIntoView={this.state.allowScroll}
					limits={this.state.limitForCategory} />
			</div>
		);
	}
}

// symbolKindName takes in the value of a SymbolInformation.Kind and
// returns the corresponding name for the kind. This is translated
// over from the values of the SymbolKind constants in
// pkg/lsp/service.go.
function symbolKindName(kind: number): string {
	switch (kind) {
	case 1:
		return "file";
	case 2:
		return "module";
	case 3:
		return "namespace";
	case 4:
		return "package";
	case 5:
		return "class";
	case 6:
		return "method";
	case 7:
		return "property";
	case 8:
		return "field";
	case 9:
		return "constructor";
	case 10:
		return "enum";
	case 11:
		return "interface";
	case 12:
		return "function";
	case 13:
		return "variable";
	case 14:
		return "constant";
	case 15:
		return "string";
	case 16:
		return "number";
	case 17:
		return "boolean";
	case 18:
		return "array";
	default:
		return "";
	}
}

// rankFile scores a filepath against a search query, and filters out bad matches.
export const rankFile = (fileResults, file, query) => {
	if (file.length < query.length) {
		// Return early to avoid an expensive query.
		return fileResults;
	}
	if (query === "") {
		// If we don't have a query, no sense scoring anything.
		fileResults.push({ title: file, description: "", index: -1, length: undefined,  score: 0 });
		return fileResults;
	}

	// Score against the full path.
	const fuzziness = .8;
	const minimumSimilarity = .6;
	let score = file.score(query, fuzziness);

	// Score against the last element of the path.
	const basePathRegExp = /.*\/(.+)/;
	const base: any = basePathRegExp.exec(file);
	const baseScore = base ? base[1].score(query, fuzziness) : 0;
	score = Math.max(score, baseScore);

	// Substring matches, with a bonus for prefix.
	const index = file.toLowerCase().indexOf(query);
	if (index === 0) {
		const prefixScore = .8;
		score = Math.max(prefixScore, score);
	} else if (index > 0) {
		const substringScore = .6;
		score = Math.max(substringScore, score);
	}

	// Don't update the results if it isn't good enough.
	if (score < minimumSimilarity) {
		return fileResults;
	}

	const l = index > -1 ? query.length : undefined;
	fileResults.push({ title: file, description: "", index: index, length: l,  score: score});
	return fileResults;
};
