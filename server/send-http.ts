/** Map a send/edit refusal onto an HTTP status. Success stays a normal 200. */
export function rejectionForSendError(error: string | undefined): { status: number; message: string } | null {
  if (!error) return null;
  if (error === 'no such bot' || error === 'no such message') return { status: 404, message: error };
  if (error === 'text is required') return { status: 400, message: error };
  if (error === 'spend-cap') return { status: 409, message: 'Spend cap reached. Confirm to allow the next turn.' };
  if (error === 'busy') return { status: 409, message: 'This bot is busy and this engine cannot queue another message.' };
  return { status: 409, message: error };
}
