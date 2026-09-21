import dashboard from "../../dist/server/index.js";
export default { fetch(request: Request, env: unknown, ctx: ExecutionContext) { return dashboard.fetch(request, env, ctx); } };
