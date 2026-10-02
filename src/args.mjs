// Command-line parsing: positional arguments and --flags (`--name value` or
// `--name=value`).

// Switches never take a value: `deploy --prod ./dir` keeps ./dir positional
const BOOLEAN_FLAGS = new Set(["prod", "take-over", "dry-run", "follow", "json", "yes", "help", "secret", "details", "ungrouped", "overwrite", "all", "public", "payg", "keep-changed", "hide-missing", "new-hidden", "apply", "yaml"]);

export function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h") {
      flags.help = true;
    } else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      let name;
      let value;
      if (eq !== -1) {
        name = arg.slice(2, eq);
        value = arg.slice(eq + 1);
      } else if (!BOOLEAN_FLAGS.has(arg.slice(2)) && i + 1 < args.length && !args[i + 1].startsWith("--")) {
        name = arg.slice(2);
        value = args[++i];
      } else {
        name = arg.slice(2);
        value = true;
      }
      // A repeated flag (--quota a=1 --quota b=2) collects its values
      if (name in flags && typeof value === "string") flags[name] = [].concat(flags[name], value);
      else flags[name] = value;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

// A flag that must carry text (`--note text`), or undefined; repeated, the last one
export function text(flags, name) {
  const value = Array.isArray(flags[name]) ? flags[name].at(-1) : flags[name];
  return typeof value === "string" ? value : undefined;
}

// Every value of a repeatable flag
export function list(flags, name) {
  return [].concat(flags[name] ?? []).filter((value) => typeof value === "string");
}
