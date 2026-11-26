// The tools registry forwards `parameters` to the model verbatim, so a tool
// must already hand it JSON Schema. Author tools with the compact
// `{ required: true }` form and compile them here.
export function params(spec) {
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = value;
    properties[key] = rest;
    if (isRequired === true) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}
