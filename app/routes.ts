import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  layout("routes/_app.tsx", [
    layout("routes/_workspace.tsx", [
      index("routes/home.tsx"),
      route("recipes/:id", "routes/recipes.$id.tsx"),
    ]),
    route("logout", "routes/logout.tsx"),
    route("flat/settings", "routes/flat.settings.tsx"),
    route("kitchen", "routes/kitchen.tsx"),
    route("recipes/new", "routes/recipes.new.tsx"),
    route("recipes/:id/edit", "routes/recipes.$id.edit.tsx"),
    route("recipes/:id/photo", "routes/recipes.$id.photo.tsx"),
  ]),
  route("login", "routes/login.tsx"),
  route("invite/:token", "routes/invite.$token.tsx"),
  route("admin/tenants", "routes/admin.tenants.tsx"),
  route("u/:id/avatar/:token", "routes/u.$id.avatar.$token.tsx"),
  route("r/:id", "routes/r.$id.tsx"),
  route("r/:id/photo", "routes/r.$id.photo.tsx"),
  route("h/:flatId", "routes/h.$flatId.tsx"),
  route(".well-known/oauth-protected-resource", "routes/oauth.metadata.ts", {
    id: "oauth-metadata-protected-resource",
  }),
  route(".well-known/oauth-authorization-server", "routes/oauth.metadata.ts", {
    id: "oauth-metadata-authorization-server",
  }),
  route("oauth/register", "routes/oauth.register.ts"),
  route("oauth/authorize", "routes/oauth.authorize.tsx"),
  route("oauth/token", "routes/oauth.token.ts"),
  route("mcp", "routes/mcp.ts"),
] satisfies RouteConfig;
