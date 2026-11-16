import {
  StreamLanguage,
  type StreamParser,
  type StringStream,
} from "@codemirror/language";

interface TomlState {
  quote: string | null;
}
const parser: StreamParser<TomlState> = {
  startState: () => ({ quote: null }),
  token(stream, state) {
    if (state.quote) return quoted(stream, state);
    if (stream.eatSpace()) return null;
    if (stream.match("#")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.sol() && stream.match(/\[\[?[^\n]*?\]\]?/))
      return "propertyName";
    for (const quote of ['"""', "'''", '"', "'"]) {
      if (stream.match(quote)) {
        state.quote = quote;
        return quoted(stream, state);
      }
    }
    if (stream.match(/[A-Za-z0-9_-]+(?=\s*(?:=|\.))/)) return "propertyName";
    if (stream.match(/(?:true|false)\b/)) return "bool";
    if (stream.match(/[+-]?(?:inf|nan)\b/)) return "number";
    if (
      stream.match(/[+-]?(?:\d[\d_]*(?:[.eE:+-][\d_]+)*|0[xob][0-9a-fA-F_]+)/)
    )
      return "number";
    if (stream.match(/[=.,\[\]{}]/)) return "punctuation";
    stream.next();
    return null;
  },
};
function quoted(stream: StringStream, state: TomlState): string {
  const quote = state.quote!;
  while (!stream.eol()) {
    if (stream.match(quote)) {
      state.quote = null;
      break;
    }
    if (quote.startsWith('"') && stream.next() === "\\") stream.next();
    else if (quote.startsWith("'")) stream.next();
  }
  // Only triple-quoted strings may continue on a later line in TOML.
  if (quote.length === 1) state.quote = null;
  return "string";
}
export const tomlLanguage = StreamLanguage.define(parser);
