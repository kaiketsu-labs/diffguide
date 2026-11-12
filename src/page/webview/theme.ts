/** Sends the theme's colors to the extension for the tab icon. */
import { post } from './transport.js';

/** Colors of the PR icons in the sidebar; the extension draws the tab icon in the theme's values, since tabs drop a theme icon's color. */
const tabIconColors = ['diffGuide.agent', 'charts.green', 'charts.purple', 'charts.red', 'charts.yellow', 'testing.iconPassed', 'testing.iconFailed', 'descriptionForeground'];
let sentColors = '';
export function sendThemeColors(): void {
  const style = getComputedStyle(document.documentElement);
  const colors = Object.fromEntries(tabIconColors.map((id) => [id, style.getPropertyValue('--vscode-' + id.replaceAll('.', '-')).trim()]).filter(([, value]) => value));
  const key = JSON.stringify(colors);
  if (key === sentColors) return;
  sentColors = key;
  post({ action: 'theme-colors', colors });
}
