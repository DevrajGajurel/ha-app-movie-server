export interface SidebarItem {
  icon: string;
  label: string;
}

export const SIDEBAR_ITEMS: SidebarItem[] = [
  { icon: "⌂", label: "Home" },
  { icon: "🔍", label: "Search" },
  { icon: "▤", label: "Library" },
  { icon: "⬇", label: "Downloads" },
  { icon: "🎬", label: "Cineby" },
];

export type SidebarView = "browse" | "search" | "library" | "downloads" | "cineby";

export const SIDEBAR_VIEWS: SidebarView[] = ["browse", "search", "library", "downloads", "cineby"];

interface SidebarProps {
  activeIndex: number;
  focusedIndex: number | null;
  onSelect: (index: number) => void;
}

export function Sidebar({ activeIndex, focusedIndex, onSelect }: SidebarProps) {
  return (
    <nav className="sidebar">
      <div className="sidebar-logo">M</div>
      <div className="sidebar-items">
        {SIDEBAR_ITEMS.map((item, i) => (
          <div
            key={item.label}
            className={"sidebar-item" + (i === activeIndex ? " active" : "") + (i === focusedIndex ? " focused" : "")}
            onClick={() => onSelect(i)}
          >
            <span className="icon">{item.icon}</span>
            <span>{item.label}</span>
          </div>
        ))}
      </div>
    </nav>
  );
}
