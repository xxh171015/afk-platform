import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { FileText, Inbox, LayoutDashboard, Moon, PanelLeft, Search, Sun } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { blockedCount } from "@/api/client";
import { blockedQuery } from "@/api/queries";
import { CommandSearch } from "@/components/afk/command-search";
import { applyTheme, currentTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { KeyboardHelp } from "@/components/afk/keyboard-help";
import { useChangeFlash } from "@/hooks/use-change-flash";
import { isEditingTarget, shortcutDestination } from "@/lib/keyboard";

const nav = [
  { to: "/", label: "工作台", icon: LayoutDashboard, exact: true },
  { to: "/specs", label: "需求", icon: FileText, exact: false },
  { to: "/waiting", label: "待处理", icon: Inbox, exact: false, badge: true },
] as const;

function ThemeToggle({ collapsed }: { collapsed: boolean }) {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => setTheme(currentTheme()), []);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      aria-label={theme === "dark" ? "切换到亮色" : "切换到暗色"}
    >
      {theme === "dark" ? <Sun className="size-4 shrink-0" /> : <Moon className="size-4 shrink-0" />}
      {!collapsed && <span>{theme === "dark" ? "亮色模式" : "暗色模式"}</span>}
    </button>
  );
}

function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { data } = useQuery(blockedQuery());
  const waiting = data ? blockedCount(data) : 0;
  const countIncreased = useChangeFlash(waiting, true);

  return (
    <aside
      className={cn(
        "afk-sidebar sticky top-0 flex h-screen shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-150",
        collapsed ? "w-[52px]" : "w-[200px]",
      )}
    >
      <div className="flex h-12 items-center gap-2 border-b border-sidebar-border px-3">
        <div className="grid size-6 shrink-0 place-items-center rounded-sm bg-primary font-mono text-[10px] font-bold text-primary-foreground">
          AFK
        </div>
        {!collapsed && <span className="truncate text-[13px] font-semibold">AFK 平台</span>}
      </div>
      <nav className="flex-1 space-y-0.5 p-2">
        {nav.map((item) => {
          const active = item.exact ? path === item.to : path === item.to || path.startsWith(item.to + "/");
          const Icon = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to}
              title={collapsed ? item.label : undefined}
              className={cn(
                "relative flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
              {"badge" in item && waiting > 0 && (
                <span
                  aria-label={`${waiting} 项待处理`}
                  className={cn(
                    "grid h-4 min-w-4 place-items-center rounded-full bg-state-blocked px-1 font-mono text-[10px] font-semibold text-background tabular",
                    countIncreased && "afk-count-bounce",
                    collapsed && "absolute -top-0.5 right-0.5",
                  )}
                >
                  {waiting}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="space-y-0.5 border-t border-sidebar-border p-2">
        <ThemeToggle collapsed={collapsed} />
        <button
          type="button"
          onClick={onToggle}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] text-sidebar-foreground hover:bg-sidebar-accent"
          aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
        >
          <PanelLeft className="size-4 shrink-0" />
          {!collapsed && <span>收起</span>}
        </button>
      </div>
    </aside>
  );
}

export interface Crumb {
  label: ReactNode;
  to?: string;
}

function useCrumbs(): Crumb[] {
  const path = useRouterState({ select: (s) => s.location.pathname });
  if (path === "/") return [{ label: "工作台" }];
  if (path === "/waiting") return [{ label: "待处理" }];
  if (path === "/specs") return [{ label: "需求" }];
  const spec = path.match(/^\/specs\/([^/]+)/);
  if (spec) return [{ label: "需求", to: "/specs" }, { label: <span className="font-mono">{decodeURIComponent(spec[1] ?? "")}</span> }];
  const tkt = path.match(/^\/tickets\/([^/]+)/);
  if (tkt) return [{ label: "票" }, { label: <span className="font-mono">{decodeURIComponent(tkt[1] ?? "")}</span> }];
  const run = path.match(/^\/runs\/([^/]+)/);
  if (run) return [{ label: "Run" }, { label: <span className="font-mono">{decodeURIComponent(run[1] ?? "")}</span> }];
  return [];
}

function Topbar({ onSearch }: { onSearch: () => void }) {
  const crumbs = useCrumbs();
  const path = useRouterState({ select: s => s.location.pathname });
  const { data } = useQuery(blockedQuery());
  const waiting = data ? blockedCount(data) : 0;
  return (
    <header className="afk-topbar sticky top-0 z-20 flex h-12 items-center gap-3 border-b bg-background/85 px-5 backdrop-blur">
      <nav aria-label="面包屑" className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px]">
        <span className="text-subtle-foreground">shop</span>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1.5">
            <span className="text-subtle-foreground">/</span>
            {c.to ? (
              <Link to={c.to} className="text-muted-foreground hover:text-foreground">
                {c.label}
              </Link>
            ) : (
              <span className="text-foreground">{c.label}</span>
            )}
          </span>
        ))}
      </nav>
      <nav aria-label="顶部导航" className="flex shrink-0 items-center gap-1 text-xs">
        {nav.map(item => <Link key={item.to} to={item.to} aria-current={(item.exact ? path === item.to : path.startsWith(item.to)) ? "page" : undefined}
          className="flex h-7 items-center gap-1.5 rounded-sm px-2 text-muted-foreground hover:bg-accent hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:text-foreground">
          {item.label}{"badge" in item && waiting > 0 && <span className="font-mono text-state-blocked tabular">{waiting}</span>}
        </Link>)}
      </nav>
      <Button
        type="button"
        variant="ghost"
        aria-label="全局搜索"
        onClick={onSearch}
        className="flex h-7 w-64 items-center gap-2 rounded-md border bg-surface px-2 text-[12px] text-muted-foreground hover:border-border-strong"
      >
        <Search className="size-3.5" />
        <span className="flex-1 text-left">搜索需求、票、运行…</span>
        <kbd className="rounded-sm border bg-background px-1 font-mono text-[10px]">⌘K</kbd>
      </Button>
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const navigate = useNavigate();
  const { data: blocked } = useQuery(blockedQuery());
  const waiting = blocked ? blockedCount(blocked) : 0;

  useEffect(() => {
    const update = () => {
      const base = document.title.replace(/^\(\d+\)\s*/, "");
      const next = waiting > 0 ? `(${waiting}) ${base}` : base;
      if (document.title !== next) document.title = next;
    };
    update();
    const title = document.querySelector("title");
    const observer = new MutationObserver(update);
    if (title) observer.observe(title, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [waiting]);

  useEffect(() => {
    let prefix = "";
    let lastKeyAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isEditingTarget(e.target) || document.querySelector('[role="dialog"], [role="alertdialog"]')) { prefix = ""; return; }
      if (e.key === "?") { e.preventDefault(); setHelpOpen(true); prefix = ""; return; }
      const key = e.key.toLowerCase();
      const destination = Date.now() - lastKeyAt < 1000 ? shortcutDestination(prefix, key) : undefined;
      prefix = key === "g" ? "g" : "";
      lastKeyAt = Date.now();
      if (destination) { e.preventDefault(); void navigate({ to: destination }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  return (
    <div className="flex min-h-screen w-full">
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onSearch={() => setSearchOpen(true)} />
        <main className="flex-1">{children}</main>
      </div>
      {searchOpen && <CommandSearch open={searchOpen} onOpenChange={setSearchOpen} />}
      <KeyboardHelp open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}

/** 页面统一外框 */
export function Page({ title, subtitle, actions, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1280px] px-6 py-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          {subtitle && <div className="mt-1 text-[13px] text-muted-foreground">{subtitle}</div>}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}
