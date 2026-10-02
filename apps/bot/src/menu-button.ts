import type { Api } from 'grammy';

export const MENU_BUTTON_TEXT = '🛍 VITALO';

/**
 * Points the bot's menu button (bottom-left in every chat) at the Mini App. Called whenever the dev
 * tunnel gets a new address, and on bot start.
 */
export async function setMenuButton(api: Pick<Api, 'setChatMenuButton'>, url: string): Promise<void> {
  await api.setChatMenuButton({ menu_button: { type: 'web_app', text: MENU_BUTTON_TEXT, web_app: { url: `${url}/` } } });
}
