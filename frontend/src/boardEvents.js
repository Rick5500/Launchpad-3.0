export const BOARD_REFRESH_EVENT = 'launchpad:board-refresh';

export function requestBoardRefresh() {
  window.dispatchEvent(new CustomEvent(BOARD_REFRESH_EVENT));
}
