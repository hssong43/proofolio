import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const base = (size: number, strokeWidth: number, color: string, rest: SVGProps<SVGSVGElement>) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: color,
  strokeWidth,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...rest,
});

export function Logo() {
  return (
    <svg width={28} height={28} viewBox="0 0 28 28" aria-label="Proofolio">
      <rect width={28} height={28} rx={7} fill="#18181B" />
      <path d="M9 21V7.5A1.5 1.5 0 0 1 10.5 6h5a3.5 3.5 0 0 1 0 7H9" fill="none" stroke="#fff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 19.5l2.5 2.5L21 16.5" fill="none" stroke="#fff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CheckIcon({ size = 12, strokeWidth = 3, color = "#fff", ...rest }: IconProps & { strokeWidth?: number; color?: string }) {
  return (
    <svg {...base(size, strokeWidth, color, rest)}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function PaletteIcon({ size = 28, ...rest }: IconProps) {
  return (
    <svg {...base(size, 2, "#18181B", rest)}>
      <circle cx={13.5} cy={6.5} r={0.5} fill="#18181B" />
      <circle cx={17.5} cy={10.5} r={0.5} fill="#18181B" />
      <circle cx={8.5} cy={7.5} r={0.5} fill="#18181B" />
      <circle cx={6.5} cy={12.5} r={0.5} fill="#18181B" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
    </svg>
  );
}

export function CodeIcon({ size = 28, ...rest }: IconProps) {
  return (
    <svg {...base(size, 2, "#18181B", rest)}>
      <path d="m18 16 4-4-4-4" />
      <path d="m6 8-4 4 4 4" />
      <path d="m14.5 4-5 16" />
    </svg>
  );
}

export function MegaphoneIcon({ size = 28, ...rest }: IconProps) {
  return (
    <svg {...base(size, 2, "#18181B", rest)}>
      <path d="m3 11 18-5v12L3 14v-3z" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </svg>
  );
}

export function UploadIcon({ size = 32, ...rest }: IconProps) {
  return (
    <svg {...base(size, 1.75, "#18181B", rest)}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5" />
      <path d="M12 3v12" />
    </svg>
  );
}

export function FileIcon({ size = 20, ...rest }: IconProps) {
  return (
    <svg {...base(size, 2, "#18181B", rest)}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </svg>
  );
}

export function CloseIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, 2, "currentColor", rest)}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function InfoIcon({ size = 18, ...rest }: IconProps) {
  return (
    <svg {...base(size, 2, "#18181B", rest)}>
      <circle cx={12} cy={12} r={10} />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}
