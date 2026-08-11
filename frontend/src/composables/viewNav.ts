import { ref } from "vue";

// Views are switched by App.vue rather than by the router, so a view that wants to send the
// person somewhere else asks for it here and App.vue does the switching. The request also
// carries what the target needs: the Messenger opens on the account it was asked for rather
// than on whichever one it had last.

export type RequestedView = "accounts" | "messenger" | "jobs" | "logs";

/** Set by a view, taken by App.vue, which clears it. */
export const requestedView = ref<RequestedView | null>(null);

/** The account the Messenger should open on. Taken by MessengerView, which clears it. */
export const messengerAccountId = ref<number | null>(null);

export function openMessengerFor(accountId: number): void {
  messengerAccountId.value = accountId;
  requestedView.value = "messenger";
}

/** What the Messenger was asked to open on, read once: a later visit is the person's own. */
export function takeMessengerAccountId(): number | null {
  const id = messengerAccountId.value;
  messengerAccountId.value = null;
  return id;
}
