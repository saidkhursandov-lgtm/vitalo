/** Click SHOP API codes our server answers with (docs.click.uz → SHOP API → Ошибки). Always HTTP 200, JSON. */
export const CLICK_ERRORS = {
  success: { error: 0, error_note: 'Success' },
  signFailed: { error: -1, error_note: 'SIGN CHECK FAILED!' },
  wrongAmount: { error: -2, error_note: 'Incorrect parameter amount' },
  actionNotFound: { error: -3, error_note: 'Action not found' },
  alreadyPaid: { error: -4, error_note: 'Already paid' },
  orderNotFound: { error: -5, error_note: 'User does not exist' },
  txNotFound: { error: -6, error_note: 'Transaction does not exist' },
  updateFailed: { error: -7, error_note: 'Failed to update user' },
  badRequest: { error: -8, error_note: 'Error in request from click' },
  cancelled: { error: -9, error_note: 'Transaction cancelled' },
} as const;

export type ClickStatus = (typeof CLICK_ERRORS)[keyof typeof CLICK_ERRORS];

/** Click transaction states in click_transactions.state. */
export const CLICK_STATE = { prepared: 0, completed: 1, cancelled: -1 } as const;
