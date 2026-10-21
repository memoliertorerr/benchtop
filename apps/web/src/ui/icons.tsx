import type { JSX } from 'preact';

type IconProps = JSX.SVGAttributes<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const PlayIcon = () => (
  <Icon>
    <path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />
  </Icon>
);

export const PauseIcon = () => (
  <Icon>
    <path d="M8 5v14M16 5v14" />
  </Icon>
);

export const RecordIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />
  </Icon>
);

export const StopIcon = () => (
  <Icon>
    <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none" />
  </Icon>
);

export const ResetIcon = () => (
  <Icon>
    <path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.6" />
    <path d="M4 4v4.6h4.6" />
  </Icon>
);

export const ChipIcon = () => (
  <Icon>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
    <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
  </Icon>
);

export const SpeakerIcon = () => (
  <Icon>
    <path d="M11 5 6 9H3v6h3l5 4z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
  </Icon>
);

export const SpeakerOffIcon = () => (
  <Icon>
    <path d="M11 5 6 9H3v6h3l5 4z" />
    <path d="m16 9 6 6M22 9l-6 6" />
  </Icon>
);

export const ProbeIcon = () => (
  <Icon>
    <path d="M14.5 4.5l5 5" />
    <path d="M17 7l-8.5 8.5-3-3L14 4" />
    <path d="M6.5 14.5L3 21" />
  </Icon>
);
