import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  layout("routes/_app.tsx", [
    index("routes/home.tsx"),
    route("logout", "routes/logout.tsx"),
    route("flat/settings", "routes/flat.settings.tsx"),
  ]),
  route("login", "routes/login.tsx"),
  route("invite/:token", "routes/invite.$token.tsx"),
  route("admin/tenants", "routes/admin.tenants.tsx"),
] satisfies RouteConfig;

