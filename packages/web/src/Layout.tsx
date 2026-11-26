import {
  Link,
  Outlet,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import {
  BarChart3,
  CircleHelp,
  ClipboardCheck,
  FileText,
  Inbox,
  LayoutDashboard,
  Menu,
  Moon,
  PanelLeft,
  Search,
  Server,
  Sun,
} from "lucide-react";
import { useEffect, useState } from "react";
import { AgentsPausedBanner } from "./AgentsPausedBanner.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { Button } from "./components/ui/button.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "./components/ui/sheet.tsx";
import { Toaster } from "./components/ui/sonner.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { DiskBanner } from "./DiskBanner.tsx";
import { EntityCrumbs } from "./EntityCrumbs.tsx";
import { EventsProvider } from "./EventsProvider.tsx";
import { HelpDialog } from "./HelpDialog.tsx";
import { useChangeFlash } from "./hooks/use-change-flash.ts";
import { applyTheme, currentTheme, type Theme } from "./lib/theme.ts";
import { cn } from "./lib/utils.ts";
import { reviewBadgeCount, useReviewQueue } from "./ReviewQueue.tsx";
import { isTypingTarget, shortcutFromKey } from "./shortcuts.ts";
import { TokenExpiryBanner } from "./TokenExpiryBanner.tsx";
import { useWorkbench } from "./Workbench.tsx";
import { waitingCount } from "./waiting.ts";

const nav = [
  { to: "/", label: "工作台", icon: LayoutDashboard, exact: true },
  { to: "/specs", label: "需求", icon: FileText, exact: false },
  {
    to: "/review",
    label: "待审",
    icon: ClipboardCheck,
    exact: true,
    badge: "review" as const,
  },
  {
    to: "/waiting",
    label: "待处理",
    icon: Inbox,
    exact: false,
    badge: "waiting" as const,
  },
  { to: "/metrics", label: "度量", icon: BarChart3, exact: false },
  { to: "/runtime", label: "运行实例", icon: Server, exact: false },
] as const;

function ThemeToggle({
  collapsed,
  theme,
  onThemeChange,
}: {
  collapsed: boolean;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}) {
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => onThemeChange(next)}
      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      aria-label={theme === "dark" ? "切换到亮色" : "切换到暗色"}
      title={theme === "dark" ? "切换到亮色" : "切换到暗色"}
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
  review,
  onHelp,
  onNavigate,
  theme,
  onThemeChange,
  mobile = false,
}: {
  collapsed: boolean;
  onToggle?: () => void;
  waiting: number;
  review: number;
  onHelp: () => void;
  onNavigate?: () => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  mobile?: boolean;
}) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const waitingIncreased = useChangeFlash(waiting, true);
  const reviewIncreased = useChangeFlash(review, true);
  return (
    <aside
      className={cn(
        "afk-sidebar shrink-0 flex-col bg-sidebar transition-[width] duration-150",
        mobile
          ? "flex h-full w-full"
          : "sticky top-0 hidden h-dvh border-r border-sidebar-border sm:flex",
        !mobile && (collapsed ? "w-[56px]" : "w-[216px]"),
      )}
    >
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
        <img src="/icon.png" alt="" className="size-6 shrink-0 rounded-md" />
        {!collapsed && (
          <span className="min-w-0">
            <strong className="block truncate text-[13px] font-semibold leading-tight">
              AFK
            </strong>
            <span className="mt-0.5 block text-[11px] text-muted-foreground">
              研发工作区
            </span>
          </span>
        )}
      </div>
      <nav className="flex-1 space-y-0.5 px-2 py-3" aria-label="主导航">
        {!collapsed && (
          <p className="mb-2 px-2 text-[11px] font-medium text-muted-foreground">
            工作区
          </p>
        )}
        {nav.map((item) => {
          const active = item.exact
            ? path === item.to
            : path === item.to || path.startsWith(`${item.to}/`);
          const Icon = item.icon;
          const badge = "badge" in item ? item.badge : undefined;
          const count =
            badge === "review" ? review : badge === "waiting" ? waiting : 0;
          const countLabel =
            count > 0 ? `${item.label} (${count})` : item.label;
          return (
            <Link
              key={item.to}
              to={item.to}
              title={item.label}
              aria-current={active ? "page" : undefined}
              aria-label={badge ? countLabel : item.label}
              onClick={onNavigate}
              className={cn(
                "relative flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                active &&
                  "afk-nav-active bg-sidebar-accent font-medium text-sidebar-accent-foreground",
              )}
            >
              <Icon className="size-[15px] shrink-0" />
              {!collapsed && (
                <span className="flex-1 truncate">{item.label}</span>
              )}
              {badge && count > 0 ? (
                <span
                  role="status"
                  aria-label={
                    badge === "review" ? `${count} 项待审` : `${count} 项待处理`
                  }
                  className={cn(
                    "grid h-[18px] min-w-[18px] place-items-center rounded-sm bg-state-blocked/12 px-1 text-[10px] font-medium text-state-blocked tabular",
                    (badge === "review" ? reviewIncreased : waitingIncreased) &&
                      "afk-count-bounce",
                    collapsed && "absolute -top-0.5 right-0.5",
                  )}
                >
                  {count}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
      <div className="space-y-0.5 border-t border-sidebar-border p-2">
        <button
          type="button"
          onClick={onHelp}
          title="快捷键帮助 (?)"
          aria-label="快捷键帮助"
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <CircleHelp className="size-4 shrink-0" />
          {!collapsed && (
            <>
              <span className="flex-1 text-left">快捷键帮助</span>
              <kbd className="afk-kbd">?</kbd>
            </>
          )}
        </button>
        <ThemeToggle
          collapsed={collapsed}
          theme={theme}
          onThemeChange={onThemeChange}
        />
        {!mobile && (
          <button
            type="button"
            onClick={onToggle}
            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] text-sidebar-foreground hover:bg-sidebar-accent"
            aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
            title={collapsed ? "展开侧边栏" : "收起侧边栏"}
            aria-expanded={!collapsed}
          >
            <PanelLeft className="size-4 shrink-0" />
            {!collapsed && <span>收起</span>}
          </button>
        )}
      </div>
    </aside>
  );
}

function Topbar({ onSearch }: { onSearch: () => void }) {
  return (
    <header className="afk-topbar sticky top-0 z-20 flex h-12 shrink-0 items-center gap-3 border-b bg-background px-4 lg:px-7">
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 sm:hidden"
          aria-label="打开导航"
        >
          <Menu />
        </Button>
      </SheetTrigger>
      <EntityCrumbs />
      <Button
        type="button"
        variant="ghost"
        aria-label="搜索需求与票"
        onClick={onSearch}
        aria-keyshortcuts="Meta+k Control+k"
        className="afk-search ml-auto flex h-7 w-56 shrink-0 items-center gap-2 rounded-md border border-transparent px-2 text-[12px] text-muted-foreground hover:border-border hover:bg-surface"
      >
        <Search className="size-3.5" />
        <span className="flex-1 text-left">搜索需求、票、运行…</span>
        <kbd className="afk-kbd">⌘K</kbd>
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
  const reviewQueue = useReviewQueue();
  const navigate = useNavigate();
  const router = useRouter();
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const changeTheme = (next: Theme) => {
    applyTheme(next);
    setTheme(next);
  };
  const waiting = board.data ? waitingCount(board.data.waiting) : 0;
  const review = reviewQueue.data ? reviewBadgeCount(reviewQueue.data) : 0;

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
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <a href="#main-content" className="afk-skip-link">
          跳到主要内容
        </a>
        <div className="flex min-h-dvh w-full">
          <Sidebar
            collapsed={collapsed}
            onToggle={() => setCollapsed((c) => !c)}
            waiting={waiting}
            review={review}
            onHelp={() => setHelpOpen(true)}
            theme={theme}
            onThemeChange={changeTheme}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <Topbar onSearch={() => setSearchOpen(true)} />
            <TokenExpiryBanner />
            <AgentsPausedBanner />
            <DiskBanner />
            <main
              id="main-content"
              tabIndex={-1}
              className="min-w-0 flex-1 outline-none"
            >
              <Outlet />
            </main>
          </div>
          <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
          <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
          <Toaster />
        </div>
        <SheetContent
          side="left"
          className="w-[272px] max-w-[85vw] bg-sidebar p-0"
        >
          <SheetTitle className="sr-only">工作区导航</SheetTitle>
          <SheetDescription className="sr-only">
            选择要打开的页面，按 Escape 关闭导航。
          </SheetDescription>
          <Sidebar
            collapsed={false}
            waiting={waiting}
            review={review}
            theme={theme}
            onThemeChange={changeTheme}
            mobile
            onNavigate={() => setMobileOpen(false)}
            onHelp={() => {
              setMobileOpen(false);
              setHelpOpen(true);
            }}
          />
        </SheetContent>
      </Sheet>
    </TooltipProvider>
  );
}
