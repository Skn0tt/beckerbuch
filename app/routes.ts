import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  layout("routes/_app.tsx", [
    index("routes/home.tsx"),
    route("logout", "routes/logout.tsx"),
    route("flat/settings", "routes/flat.settings.tsx"),
    route("recipes/new", "routes/recipes.new.tsx"),
    route("recipes/:id", "routes/recipes.$id.tsx"),
    route("recipes/:id/edit", "routes/recipes.$id.edit.tsx"),
  ]),
  route("login", "routes/login.tsx"),
  route("invite/:token", "routes/invite.$token.tsx"),
  route("admin/tenants", "routes/admin.tenants.tsx"),
] satisfies RouteConfig;

