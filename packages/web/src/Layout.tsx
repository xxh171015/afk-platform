import {
  Link,
  Outlet,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import {
  FileText,
  Inbox,
  LayoutDashboard,
  Moon,
  PanelLeft,
  Search,
  Sun,
} from "lucide-react";
import { useEffect, useState } from "react";
import { CommandPalette } from "./CommandPalette.tsx";
import { Button } from "./components/ui/button.tsx";
import { Toaster } from "./components/ui/sonner.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { EntityCrumbs } from "./EntityCrumbs.tsx";
import { EventsProvider } from "./EventsProvider.tsx";
import { HelpDialog } from "./HelpDialog.tsx";
import { useChangeFlash } from "./hooks/use-change-flash.ts";
import { applyTheme, currentTheme, type Theme } from "./lib/theme.ts";
import { cn } from "./lib/utils.ts";
import { isTypingTarget, shortcutFromKey } from "./shortcuts.ts";
import { useWorkbench } from "./Workbench.tsx";
import { waitingCount } from "./waiting.ts";

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
      {theme === "dark" ? (
        <Sun className="size-4 shrink-0" />
      ) : (
        <Moon className="size-4 shrink-0" />
      )}
      {!collapsed && <span>{theme === "dark" ? "亮色模式" : "暗色模式"}</span>}
    </button>
  );
}

function Sidebar({
  collapsed,
  onToggle,
  waiting,
}: {
  collapsed: boolean;
  onToggle: () => void;
  waiting: number;
}) {
  const path = useRouterState({ select: (s) => s.location.pathname });
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
        {!collapsed && (
          <span className="truncate text-[13px] font-semibold">AFK 平台</span>
        )}
      </div>
      <nav className="flex-1 space-y-0.5 p-2">
        {nav.map((item) => {
          const active = item.exact
            ? path === item.to
            : path === item.to || path.startsWith(`${item.to}/`);
          const Icon = item.icon;
          const countLabel = waiting > 0 ? `待处理 (${waiting})` : item.label;
          return (
            <Link
              key={item.to}
              to={item.to}
              title={collapsed ? item.label : undefined}
              aria-label={"badge" in item ? countLabel : item.label}
              className={cn(
                "relative flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                active &&
                  "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              {!collapsed && (
                <span className="flex-1 truncate">{item.label}</span>
              )}
              {"badge" in item && waiting > 0 ? (
                <span
                  role="status"
                  aria-label={`${waiting} 项待处理`}
                  className={cn(
                    "grid h-4 min-w-4 place-items-center rounded-full bg-state-blocked px-1 font-mono text-[10px] font-semibold text-background tabular",
                    countIncreased && "afk-count-bounce",
                    collapsed && "absolute -top-0.5 right-0.5",
                  )}
                >
                  {waiting}
                </span>
              ) : null}
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

function Topbar({
  onSearch,
  waiting,
}: {
  onSearch: () => void;
  waiting: number;
}) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <header className="afk-topbar sticky top-0 z-20 flex h-12 items-center gap-3 border-b bg-background/85 px-5 backdrop-blur">
      <EntityCrumbs />
      <nav
        aria-label="顶部导航"
        className="flex shrink-0 items-center gap-1 text-xs"
      >
        {nav.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            aria-label={
              "badge" in item && waiting > 0
                ? `待处理 (${waiting})`
                : item.label
            }
            aria-current={
              (item.exact ? path === item.to : path.startsWith(item.to))
                ? "page"
                : undefined
            }
            className="flex h-7 items-center gap-1.5 rounded-sm px-2 text-muted-foreground hover:bg-accent hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:text-foreground"
          >
            {item.label}
            {"badge" in item && waiting > 0 ? (
              <span className="font-mono text-state-blocked tabular">
                {waiting}
              </span>
            ) : null}
          </Link>
        ))}
      </nav>
      <Button
        type="button"
        variant="ghost"
        aria-label="搜索需求与票"
        onClick={onSearch}
        className="flex h-7 w-64 items-center gap-2 rounded-md border bg-surface px-2 text-[12px] text-muted-foreground hover:border-border-strong"
      >
        <Search className="size-3.5" />
        <span className="flex-1 text-left">搜索需求、票、运行…</span>
        <kbd className="rounded-sm border bg-background px-1 font-mono text-[10px]">
          ⌘K
        </kbd>
      </Button>
    </header>
  );
}

export function Layout() {
  return (
    <EventsProvider>
      <Chrome />
    </EventsProvider>
  );
}

function Chrome() {
  const board = useWorkbench();
  const navigate = useNavigate();
  const router = useRouter();
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const waiting = board.data ? waitingCount(board.data.waiting) : 0;

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = (event.target as HTMLElement | null)?.closest("a");
      if (
        !anchor ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download")
      )
        return;
      const href = anchor.getAttribute("href");
      if (
        !href ||
        href.startsWith("http") ||
        href.startsWith("mailto:") ||
        href.startsWith("#")
      )
        return;
      event.preventDefault();
      router.history.push(href);
      const id = href.split("#")[1];
      if (id) {
        queueMicrotask(() =>
          document
            .getElementById(id)
            ?.scrollIntoView?.({ behavior: "smooth", block: "start" }),
        );
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [router]);

  useEffect(() => {
    let pendingGo = false;
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const next = shortcutFromKey(event, pendingGo);
      pendingGo = next.pendingGo;
      if (!next.shortcut) return;
      event.preventDefault();
      if (next.shortcut.type === "go") void navigate({ to: next.shortcut.to });
      if (next.shortcut.type === "search") setSearchOpen(true);
      if (next.shortcut.type === "help") setHelpOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  useEffect(() => {
    const update = () => {
      const base = document.title.replace(/^\(\d+\)\s*/, "");
      const next = waiting > 0 ? `(${waiting}) ${base}` : base;
      if (document.title !== next) document.title = next;
    };
    update();
    const title = document.querySelector("title");
    const observer = new MutationObserver(update);
    if (title)
      observer.observe(title, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    return () => observer.disconnect();
  }, [waiting]);

  return (
    <TooltipProvider>
      <div className="flex min-h-screen w-full">
        <Sidebar
          collapsed={collapsed}
          onToggle={() => setCollapsed((c) => !c)}
          waiting={waiting}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar onSearch={() => setSearchOpen(true)} waiting={waiting} />
          <main className="flex-1">
            <Outlet />
          </main>
        </div>
        <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
        <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
        <Toaster />
      </div>
    </TooltipProvider>
  );
}
