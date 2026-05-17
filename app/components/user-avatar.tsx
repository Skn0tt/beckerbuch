import { Avatar } from "@mantine/core";

type AvatarUser = {
  id: string;
  displayName: string;
  avatarKey: string | null;
};

function avatarColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return `hsl(${hash % 360} 55% 45%)`;
}

function firstCharacter(name: string): string {
  const c = name.trim().charAt(0);
  return c.length > 0 ? c.toUpperCase() : "?";
}

export function avatarToken(avatarKey: string | null): string | null {
  if (!avatarKey) return null;
  const parts = avatarKey.split("/");
  return parts[parts.length - 1] || null;
}

export function UserAvatar({
  user,
  size = "md",
}: {
  user: AvatarUser;
  size?: number | string;
}) {
  const token = avatarToken(user.avatarKey);
  const src = token ? `/u/${user.id}/avatar/${token}` : undefined;
  return (
    <Avatar
      src={src}
      alt={user.displayName}
      radius="xl"
      size={size}
      style={{
        backgroundColor: token ? undefined : avatarColor(user.id),
        color: token ? undefined : "white",
      }}
    >
      {token ? null : firstCharacter(user.displayName)}
    </Avatar>
  );
}
