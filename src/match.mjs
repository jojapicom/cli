// Endpoint matching for `jojapi dev`: the documented endpoints of the API
// ("METHOD /path/{param}") against a local request, with the gateway's rules
// (literal segments beat partial templates beat whole-segment variables; ties
// go to the first endpoint). Produces the x-jojapi-endpoint / -params headers
// the gateway would set.

function segmentRegex(segment) {
  let regex = "";
  let buffer = "";
  const names = [];
  let inVariable = false;
  for (const char of segment) {
    if (char === "{") {
      if (inVariable) return null;
      regex += buffer.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      buffer = "";
      inVariable = true;
    } else if (char === "}") {
      if (!inVariable || buffer === "") return null;
      names.push(buffer);
      regex += "(.*)";
      buffer = "";
      inVariable = false;
    } else {
      buffer += char;
    }
  }
  if (inVariable) return null;
  regex += buffer.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return { regex: new RegExp(`^${regex}$`), names };
}

export function matchEndpoint(endpoints, method, path) {
  let best = null;
  for (const endpoint of endpoints) {
    if (endpoint.method.toUpperCase() !== method.toUpperCase()) continue;
    const patternParts = endpoint.url_path.split("/");
    const pathParts = path.split("/");
    if (patternParts.length !== pathParts.length) continue;
    let specificity = 0;
    const params = {};
    let ok = true;
    for (let i = 0; i < patternParts.length; i++) {
      const pattern = patternParts[i];
      const actual = pathParts[i];
      if (pattern.startsWith("{") && pattern.endsWith("}") && pattern.indexOf("{", 1) === -1) {
        params[pattern.slice(1, -1)] = safeDecode(actual);
        specificity += 2;
        continue;
      }
      if (pattern.includes("{")) {
        const compiled = segmentRegex(pattern);
        const match = compiled?.regex.exec(actual);
        if (!match) {
          ok = false;
          break;
        }
        compiled.names.forEach((name, j) => (params[name] = safeDecode(match[j + 1] ?? "")));
        specificity += 1;
        continue;
      }
      if (pattern !== actual) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (best === null || specificity < best.specificity) best = { endpoint, params, specificity };
  }
  return best;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
