import logo from "@/assets/icons/openai.svg";
export const APP_DISPLAY_NAME = { codex: "Codex" };
export function AppGlyph({
  size = 16,
  className = "",
}: {
  app?: "codex";
  size?: number;
  badgeClassName?: string;
  className?: string;
}) {
  return (
    <img
      src={logo}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={"shrink-0 dark:brightness-0 dark:invert " + className}
    />
  );
}
