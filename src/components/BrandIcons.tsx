interface IconProps { size?: number; className?: string; }
export function SkillsIcon({ size = 16, className = "" }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M4 3h14a2 2 0 0 1 2 2v12" />
      <path d="M2 7V5a2 2 0 0 1 4 0v14a2 2 0 0 0 4 0v-2h12v2a2 2 0 0 1-2 2H8" />
      <path d="m9 10.5 1.5-2-.5 2 2-1.5-.5 1.5 2-1.5-.5 1.5 2-2" />
    </svg>
  );
}
