export type Theme = "dark" | "light";
export const THEME_KEY = "afk-theme";

/** 在 <head> 中内联执行，避免首屏闪烁；默认暗色 */
export const themeBootScript = `try{var t=localStorage.getItem("${THEME_KEY}");document.documentElement.classList.toggle("dark",t!=="light")}catch(e){}`;

export function applyTheme(t: Theme) {
  document.documentElement.classList.toggle("dark", t === "dark");
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* ignore */
  }
}

export function currentTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}
