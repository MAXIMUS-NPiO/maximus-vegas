import type { SVGProps } from "react";
type Props = SVGProps<SVGSVGElement>;

const base = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

export const Arrow = (p: Props) => (
  <svg {...base} {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
export const Chevron = (p: Props) => (
  <svg {...base} {...p}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);
export const Bell = (p: Props) => (
  <svg {...base} {...p}>
    <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0" />
  </svg>
);
export const Check = (p: Props) => (
  <svg {...base} {...p}>
    <path d="m5 12 4.5 4.5L19 7" />
  </svg>
);
export const Search = (p: Props) => (
  <svg {...base} {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </svg>
);
export const Shield = (p: Props) => (
  <svg {...base} {...p}>
    <path d="M12 3 5 6v6c0 4.4 3 7.8 7 9 4-1.2 7-4.6 7-9V6z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);
export const Trophy = (p: Props) => (
  <svg {...base} {...p}>
    <path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7M10 17h4v3h-4z" />
  </svg>
);
export const Users = (p: Props) => (
  <svg {...base} {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.2a3 3 0 0 1 0 5.6M17.5 14.2A5 5 0 0 1 20.5 19" />
  </svg>
);
export const Gamepad = (p: Props) => (
  <svg {...base} {...p}>
    <path d="M7 8h10a4 4 0 0 1 3.9 4.9l-.8 3.5a2.2 2.2 0 0 1-3.8 1l-2-2.4h-4.6l-2 2.4a2.2 2.2 0 0 1-3.8-1l-.8-3.5A4 4 0 0 1 7 8z" />
    <path d="M8 11v3M6.5 12.5h3M15.5 12h.01M17.5 13.5h.01" />
  </svg>
);

export function Brand() {
  return (
    <span className="brand" aria-hidden="true">
      <span className="brand-main">MAXIMUS</span>
      <span className="brand-sub">VEGAS</span>
    </span>
  );
}
