/**
 * The contract-expression parser — the validation kernel of the
 * contract-language bounded context (build-spec §4).
 *
 * Implements the EBNF grammar (§4.1), the grammar-level structural
 * constraints (§4.2), the frozen AST node set (§4.3), and the structured
 * error envelope (§4.4). Deterministic recursive descent, no dependencies.
 * The parser never throws on malformed input: every failure path returns
 * `{ ok: false, errors: [ParseError] }`.
 *
 * Pinned grammar decisions (see tests/parser.test.ts):
 * - Precedence (tightest first): arithmetic > comparison > not > and > or.
 * - `not` applies to the following comparison (`not_expr := "not"? comparison`).
 * - The comparison's comp_op is optional, so bare terms parse as field refs
 *   with no implicit `== true` wrap.
 * - No unary minus and no grouping parentheses anywhere in the grammar.
 * - `old(...)` is accepted ONLY inside postconditions; in preconditions and
 *   invariants it is a structured error reported after the construct has been
 *   recognized (position > 0, found matches /old/).
 */

export type ClauseKind = "preconditions" | "postconditions" | "invariants";

export type CompOp = "==" | "!=" | ">" | ">=" | "<" | "<=" | "in";

export type ArithOp = "+" | "-" | "*" | "/";

export type FieldPath = (string | number | "[]")[];

export type LiteralList = (string | number | boolean | null)[];

export type Node =
	| { type: "or"; left: Node; right: Node }
	| { type: "and"; left: Node; right: Node }
	| { type: "not"; operand: Node }
	| { type: "compare"; op: CompOp; left: Node; right: Node }
	| { type: "arithmetic"; op: ArithOp; left: Node; right: Node }
	| { type: "old"; ref: { type: "fieldRef"; path: FieldPath } }
	| { type: "predicateCall"; name: string; args: Node[] }
	| { type: "fieldRef"; path: FieldPath }
	| { type: "literal"; value: string | number | boolean | null | LiteralList };

export type ParseError = {
	contractId: string;
	field: string;
	position: number;
	found: string;
	expected: string[];
	message: string;
};

export type ParseResult =
	| { ok: true; ast: Node }
	| { ok: false; errors: ParseError[] };

type TokenKind = "ident" | "keyword" | "number" | "string" | "symbol" | "eof";

type Token = {
	kind: TokenKind;
	lexeme: string;
	position: number;
};

type FieldRefNode = { type: "fieldRef"; path: FieldPath };

type TokenizeResult =
	| { ok: true; tokens: Token[] }
	| { ok: false; error: ParseError };

const KEYWORDS = new Set([
	"or",
	"and",
	"not",
	"in",
	"true",
	"false",
	"null",
	"old",
]);

const TWO_CHAR_SYMBOLS = new Set(["==", "!=", ">=", "<="]);

const SINGLE_CHAR_SYMBOLS = new Set([
	">",
	"<",
	"+",
	"-",
	"*",
	"/",
	"(",
	")",
	"[",
	"]",
	",",
	".",
]);

const COMP_OP_SYMBOLS = new Set(["==", "!=", ">", ">=", "<", "<="]);

const ARITH_OP_SYMBOLS = new Set(["+", "-", "*", "/"]);

/**
 * Maximum expression nesting depth (nested predicate calls like
 * f(f(...(a)...))). Input nested beyond this is rejected with a structured
 * error instead of overflowing the call stack — the build-spec §4.4
 * never-throws pin under the ADR-0010 untrusted-agent model.
 */
const MAX_PARSE_DEPTH = 256;

const TERM_EXPECTED = [
	"an identifier",
	"a number",
	"a string",
	"true",
	"false",
	"null",
	"a list",
	"old(",
];

const LIST_ELEMENT_EXPECTED = ["a number", "a string", "true", "false", "null"];

function isWhitespace(char: string): boolean {
	return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function isAsciiDigit(char: string): boolean {
	return char >= "0" && char <= "9";
}

function isIdentStart(char: string): boolean {
	return (
		(char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_"
	);
}

function isIdentPart(char: string): boolean {
	return isIdentStart(char) || isAsciiDigit(char);
}

function tokenize(
	input: string,
	clauseKind: ClauseKind,
	contractId: string,
): TokenizeResult {
	const tokens: Token[] = [];
	let index = 0;

	while (index < input.length) {
		const char = input[index];

		if (isWhitespace(char)) {
			index += 1;
			continue;
		}

		if (char === '"') {
			const start = index;
			index += 1;
			let value = "";
			let closed = false;
			while (index < input.length) {
				const current = input[index];
				if (current === "\\") {
					const escaped = input[index + 1];
					if (escaped === '"' || escaped === "\\") {
						value += escaped;
						index += 2;
						continue;
					}
					value += current;
					index += 1;
					continue;
				}
				if (current === '"') {
					index += 1;
					closed = true;
					break;
				}
				value += current;
				index += 1;
			}
			if (!closed) {
				return {
					ok: false,
					error: {
						contractId,
						field: clauseKind,
						position: start,
						found: '"',
						expected: ['a closing "'],
						message: `Unterminated string literal at position ${start}`,
					},
				};
			}
			tokens.push({ kind: "string", lexeme: value, position: start });
			continue;
		}

		if (isAsciiDigit(char)) {
			const start = index;
			while (index < input.length && isAsciiDigit(input[index])) {
				index += 1;
			}
			if (input[index] === "." && isAsciiDigit(input[index + 1] ?? "")) {
				index += 1;
				while (index < input.length && isAsciiDigit(input[index])) {
					index += 1;
				}
			}
			tokens.push({
				kind: "number",
				lexeme: input.slice(start, index),
				position: start,
			});
			continue;
		}

		if (isIdentStart(char)) {
			const start = index;
			while (index < input.length && isIdentPart(input[index])) {
				index += 1;
			}
			const lexeme = input.slice(start, index);
			tokens.push({
				kind: KEYWORDS.has(lexeme) ? "keyword" : "ident",
				lexeme,
				position: start,
			});
			continue;
		}

		const pair = input[index + 1] === undefined ? "" : char + input[index + 1];
		if (TWO_CHAR_SYMBOLS.has(pair)) {
			tokens.push({ kind: "symbol", lexeme: pair, position: index });
			index += 2;
			continue;
		}

		if (SINGLE_CHAR_SYMBOLS.has(char)) {
			tokens.push({ kind: "symbol", lexeme: char, position: index });
			index += 1;
			continue;
		}

		if (char === "=") {
			return {
				ok: false,
				error: {
					contractId,
					field: clauseKind,
					position: index,
					found: "=",
					expected: ["=="],
					message: `Unexpected token '=' at position ${index} — did you mean '=='?`,
				},
			};
		}

		return {
			ok: false,
			error: {
				contractId,
				field: clauseKind,
				position: index,
				found: char,
				expected: TERM_EXPECTED,
				message: `Unexpected character '${char}' at position ${index}`,
			},
		};
	}

	tokens.push({ kind: "eof", lexeme: "", position: input.length });
	return { ok: true, tokens };
}

class Parser {
	private readonly tokens: Token[];
	private index = 0;
	private error: ParseError | null = null;
	private depth = 0;

	constructor(
		tokens: Token[],
		private readonly clauseKind: ClauseKind,
		private readonly contractId: string,
	) {
		this.tokens = tokens;
	}

	run(): ParseResult {
		const ast = this.parseOrExpr();
		if (ast === null) {
			return { ok: false, errors: [this.requireError()] };
		}
		const trailing = this.peek();
		if (trailing.kind !== "eof") {
			this.fail(
				trailing.position,
				trailing.lexeme,
				["end of expression"],
				`Unexpected token '${trailing.lexeme}' at position ${trailing.position} — expected end of expression`,
			);
			return { ok: false, errors: [this.requireError()] };
		}
		return { ok: true, ast };
	}

	private peek(): Token {
		return this.tokens[this.index];
	}

	private advance(): Token {
		const token = this.tokens[this.index];
		if (token.kind !== "eof") {
			this.index += 1;
		}
		return token;
	}

	private isKeyword(lexeme: string): boolean {
		const token = this.peek();
		return token.kind === "keyword" && token.lexeme === lexeme;
	}

	private isSymbol(lexeme: string): boolean {
		const token = this.peek();
		return token.kind === "symbol" && token.lexeme === lexeme;
	}

	private fail(
		position: number,
		found: string,
		expected: string[],
		message: string,
	): void {
		if (this.error !== null) {
			return;
		}
		this.error = {
			contractId: this.contractId,
			field: this.clauseKind,
			position,
			found,
			expected,
			message,
		};
	}

	private requireError(): ParseError {
		if (this.error === null) {
			return {
				contractId: this.contractId,
				field: this.clauseKind,
				position: 0,
				found: "",
				expected: ["end of expression"],
				message: "Internal parser invariant violated: no error recorded",
			};
		}
		return this.error;
	}

	private parseOrExpr(): Node | null {
		let left = this.parseAndExpr();
		if (left === null) {
			return null;
		}
		while (this.isKeyword("or")) {
			this.advance();
			const right = this.parseAndExpr();
			if (right === null) {
				return null;
			}
			left = { type: "or", left, right };
		}
		return left;
	}

	private parseAndExpr(): Node | null {
		let left = this.parseNotExpr();
		if (left === null) {
			return null;
		}
		while (this.isKeyword("and")) {
			this.advance();
			const right = this.parseNotExpr();
			if (right === null) {
				return null;
			}
			left = { type: "and", left, right };
		}
		return left;
	}

	private parseNotExpr(): Node | null {
		if (this.isKeyword("not")) {
			this.advance();
			const operand = this.parseComparison();
			if (operand === null) {
				return null;
			}
			return { type: "not", operand };
		}
		return this.parseComparison();
	}

	private parseComparison(): Node | null {
		const left = this.parseTerm();
		if (left === null) {
			return null;
		}
		const op = this.peekCompOp();
		if (op === null) {
			return left;
		}
		this.advance();
		const right = this.parseTerm();
		if (right === null) {
			return null;
		}
		return { type: "compare", op, left, right };
	}

	private peekCompOp(): CompOp | null {
		const token = this.peek();
		if (token.kind === "symbol" && COMP_OP_SYMBOLS.has(token.lexeme)) {
			return token.lexeme as CompOp;
		}
		if (token.kind === "keyword" && token.lexeme === "in") {
			return "in";
		}
		return null;
	}

	/**
	 * The additive level of arithmetic (`+` `-`). Left-associative and
	 * iterative: chains like "a + a + ..." are folded in a loop, so long
	 * chains cannot overflow the call stack. Precedence: `*` `/` bind tighter
	 * (parseFactor) and are parsed for every operand.
	 */
	private parseTerm(): Node | null {
		let left = this.parseFactor();
		if (left === null) {
			return null;
		}
		while (true) {
			const op = this.peekArithOp();
			if (op === null || (op !== "+" && op !== "-")) {
				break;
			}
			this.advance();
			const right = this.parseFactor();
			if (right === null) {
				return null;
			}
			left = { type: "arithmetic", op, left, right };
		}
		return left;
	}

	/**
	 * The multiplicative level of arithmetic (`*` `/`). Binds tighter than
	 * `+` `-` and is itself left-associative and iterative.
	 */
	private parseFactor(): Node | null {
		let left = this.parsePrimary();
		if (left === null) {
			return null;
		}
		while (true) {
			const op = this.peekArithOp();
			if (op === null || (op !== "*" && op !== "/")) {
				break;
			}
			this.advance();
			const right = this.parsePrimary();
			if (right === null) {
				return null;
			}
			left = { type: "arithmetic", op, left, right };
		}
		return left;
	}

	private peekArithOp(): ArithOp | null {
		const token = this.peek();
		if (token.kind === "symbol" && ARITH_OP_SYMBOLS.has(token.lexeme)) {
			return token.lexeme as ArithOp;
		}
		return null;
	}

	/**
	 * Depth-guarded entry to the recursive term grammar. Every recursive
	 * descent into a primary (nested predicate calls f(f(...(a)...))) passes
	 * through here; beyond MAX_PARSE_DEPTH the input is rejected with a
	 * structured error rather than overflowing the call stack (B1b,
	 * build-spec §4.4 never-throws pin).
	 */
	private parsePrimary(): Node | null {
		this.depth += 1;
		try {
			if (this.depth > MAX_PARSE_DEPTH) {
				const token = this.peek();
				this.fail(
					token.position,
					token.lexeme,
					["fewer levels of nesting"],
					`Expression nested too deeply at position ${token.position} — exceeds the maximum nesting depth of ${MAX_PARSE_DEPTH}`,
				);
				return null;
			}
			return this.parsePrimaryUnchecked();
		} finally {
			this.depth -= 1;
		}
	}

	private parsePrimaryUnchecked(): Node | null {
		const token = this.peek();
		switch (token.kind) {
			case "number":
				this.advance();
				return { type: "literal", value: Number(token.lexeme) };
			case "string":
				this.advance();
				return { type: "literal", value: token.lexeme };
			case "keyword":
				return this.parseKeywordPrimary();
			case "ident":
				return this.parseIdentRef();
			case "symbol":
				if (token.lexeme === "[") {
					return this.parseListLiteral();
				}
				if (token.lexeme === "(") {
					this.fail(
						token.position,
						token.lexeme,
						TERM_EXPECTED,
						`Unexpected token '(' at position ${token.position} — the grammar has no grouping parentheses`,
					);
					return null;
				}
				this.fail(
					token.position,
					token.lexeme,
					TERM_EXPECTED,
					`Unexpected token '${token.lexeme}' at position ${token.position} — expected a term`,
				);
				return null;
			case "eof":
				this.fail(
					token.position,
					"",
					TERM_EXPECTED,
					`Unexpected end of input at position ${token.position} — expected a term`,
				);
				return null;
		}
	}

	private parseKeywordPrimary(): Node | null {
		const token = this.peek();
		switch (token.lexeme) {
			case "true":
				this.advance();
				return { type: "literal", value: true };
			case "false":
				this.advance();
				return { type: "literal", value: false };
			case "null":
				this.advance();
				return { type: "literal", value: null };
			case "old":
				return this.parseOldRef();
			default:
				this.fail(
					token.position,
					token.lexeme,
					TERM_EXPECTED,
					`Unexpected keyword '${token.lexeme}' at position ${token.position} — expected a term`,
				);
				return null;
		}
	}

	private parseOldRef(): Node | null {
		this.advance(); // consume "old"
		if (!this.isSymbol("(")) {
			const token = this.peek();
			this.fail(
				token.position,
				token.lexeme,
				["("],
				`Expected '(' after 'old' at position ${token.position}`,
			);
			return null;
		}
		this.advance(); // consume "("
		const refStart = this.peek().position;
		const ref = this.parseFieldRef();
		if (ref === null) {
			return null;
		}
		if (!this.isSymbol(")")) {
			const token = this.peek();
			this.fail(
				token.position,
				token.lexeme,
				[")"],
				`Expected ')' to close old(...) at position ${token.position}`,
			);
			return null;
		}
		this.advance(); // consume ")"
		if (this.clauseKind !== "postconditions") {
			this.fail(
				refStart,
				"old",
				["a term other than old(...)"],
				`old(...) is only valid in postconditions, not ${this.clauseKind}`,
			);
			return null;
		}
		return { type: "old", ref };
	}

	private parseFieldRef(): FieldRefNode | null {
		const first = this.peek();
		if (first.kind !== "ident") {
			this.fail(
				first.position,
				first.lexeme,
				["an identifier"],
				`Expected a field identifier at position ${first.position}`,
			);
			return null;
		}
		this.advance();
		const path: FieldPath = [first.lexeme];
		return this.parseFieldRefSuffixes(path);
	}

	private parseFieldRefSuffixes(path: FieldPath): FieldRefNode | null {
		while (true) {
			if (this.isSymbol(".")) {
				this.advance();
				const segment = this.peek();
				if (segment.kind !== "ident") {
					this.fail(
						segment.position,
						segment.lexeme,
						["an identifier"],
						`Expected an identifier after '.' at position ${segment.position}`,
					);
					return null;
				}
				this.advance();
				path.push(segment.lexeme);
				continue;
			}
			if (this.isSymbol("[")) {
				this.advance();
				if (this.isSymbol("]")) {
					this.advance();
					path.push("[]");
					continue;
				}
				const index = this.peek();
				if (index.kind !== "number") {
					this.fail(
						index.position,
						index.lexeme,
						["a number", "]"],
						`Expected an index number or '[]' inside '[' at position ${index.position}`,
					);
					return null;
				}
				this.advance();
				if (!this.isSymbol("]")) {
					const close = this.peek();
					this.fail(
						close.position,
						close.lexeme,
						["]"],
						`Expected ']' to close an index at position ${close.position}`,
					);
					return null;
				}
				this.advance();
				path.push(Number(index.lexeme));
				continue;
			}
			break;
		}
		return { type: "fieldRef", path };
	}

	private parseIdentRef(): Node | null {
		const first = this.peek();
		this.advance();
		if (this.isSymbol("(")) {
			return this.parsePredicateCallArgs(first.lexeme);
		}
		const path: FieldPath = [first.lexeme];
		return this.parseFieldRefSuffixes(path);
	}

	private parsePredicateCallArgs(name: string): Node | null {
		this.advance(); // consume "("
		const args: Node[] = [];
		if (this.isSymbol(")")) {
			this.advance();
			return { type: "predicateCall", name, args };
		}
		while (true) {
			const arg = this.parseTerm();
			if (arg === null) {
				return null;
			}
			args.push(arg);
			if (this.isSymbol(",")) {
				this.advance();
				continue;
			}
			break;
		}
		if (!this.isSymbol(")")) {
			const close = this.peek();
			this.fail(
				close.position,
				close.lexeme,
				[")"],
				`Expected ')' to close predicate call '${name}' at position ${close.position}`,
			);
			return null;
		}
		this.advance();
		return { type: "predicateCall", name, args };
	}

	private parseListLiteral(): Node | null {
		this.advance(); // consume "["
		const values: LiteralList = [];
		if (this.isSymbol("]")) {
			this.advance();
			return { type: "literal", value: values };
		}
		while (true) {
			const element = this.parseListElement();
			if (element === null) {
				return null;
			}
			values.push(element.value);
			if (this.isSymbol(",")) {
				this.advance();
				continue;
			}
			break;
		}
		if (!this.isSymbol("]")) {
			const close = this.peek();
			this.fail(
				close.position,
				close.lexeme,
				["]"],
				`Expected ']' to close a list literal at position ${close.position}`,
			);
			return null;
		}
		this.advance();
		return { type: "literal", value: values };
	}

	private parseListElement(): {
		value: string | number | boolean | null;
	} | null {
		const token = this.peek();
		switch (token.kind) {
			case "number":
				this.advance();
				return { value: Number(token.lexeme) };
			case "string":
				this.advance();
				return { value: token.lexeme };
			case "keyword":
				if (token.lexeme === "true") {
					this.advance();
					return { value: true };
				}
				if (token.lexeme === "false") {
					this.advance();
					return { value: false };
				}
				if (token.lexeme === "null") {
					this.advance();
					return { value: null };
				}
				this.fail(
					token.position,
					token.lexeme,
					LIST_ELEMENT_EXPECTED,
					`Expected a literal value inside a list at position ${token.position}`,
				);
				return null;
			default:
				this.fail(
					token.position,
					token.lexeme,
					LIST_ELEMENT_EXPECTED,
					`Expected a literal value inside a list at position ${token.position}`,
				);
				return null;
		}
	}
}

export function parseExpression(
	input: string,
	clauseKind: ClauseKind,
	contractId: string,
): ParseResult {
	const tokens = tokenize(input, clauseKind, contractId);
	if (!tokens.ok) {
		return { ok: false, errors: [tokens.error] };
	}
	const parser = new Parser(tokens.tokens, clauseKind, contractId);
	return parser.run();
}
