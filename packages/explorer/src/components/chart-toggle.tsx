interface TooltipLine {
  color: string;
  label: string;
}

interface ChartToggleProps {
  label: string;
  active: boolean;
  onToggle: () => void;
  activeClass: string;
  tooltip: {
    title: string;
    description: string;
    legend: TooltipLine[];
  };
}

export function ChartToggle({ label, active, onToggle, activeClass, tooltip }: ChartToggleProps) {
  return (
    <div className="relative group">
      <button
        type="button"
        onClick={onToggle}
        className={`px-2 py-0.5 text-[10px] font-mono rounded transition-all cursor-pointer ${
          active
            ? activeClass
            : "bg-terminal-border/30 text-txt-secondary/50 border border-transparent hover:text-txt-secondary/80"
        }`}
      >
        {label}
      </button>

      <div className="absolute top-full right-0 mt-1.5 w-56 p-2.5 rounded bg-terminal-surface border border-terminal-border shadow-lg opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity duration-150 z-50">
        <p className="text-[11px] font-semibold text-txt-primary mb-1">{tooltip.title}</p>
        <p className="text-[10px] text-txt-secondary leading-relaxed mb-2">{tooltip.description}</p>
        <div className="flex flex-col gap-1">
          {tooltip.legend.map((item) => (
            <div key={item.label} className="flex items-center gap-1.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                style={{ backgroundColor: item.color }}
              />
              <span className="text-[10px] text-txt-secondary">{item.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
