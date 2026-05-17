import { Avatar } from "@mantine/core";
import type { CSSProperties } from "react";

type AvatarUser = {
  id: string;
  displayName: string;
  avatarKey: string | null;
};

function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  // Multiply by the golden angle (≈137.5°) so consecutive letters
  // land far apart on the hue wheel instead of next to each other.
  const hue = Math.floor((hash * 137.508) % 360);
  return `hsl(${hue} 55% 45%)`;
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
  const initial = firstCharacter(user.displayName);
  return (
    <Avatar
      src={src}
      alt={user.displayName}
      radius="xl"
      size={size}
      style={
        token
          ? undefined
          : ({
              "--avatar-bg": avatarColor(initial),
              "--avatar-color": "white",
            } as CSSProperties)
      }
    >
      {token ? null : initial}
    </Avatar>
  );
}
