import type { Job } from './job.js';

/** Fires only on a terminal state — never for an in-flight retry. */
export interface JobNotification {
  readonly type: 'succeeded' | 'failed';
  readonly job: Job;
}

/**
 * Out-of-app notification (Journey A, F3 / Journey B, F9): "what's done, and what
 * broke" has to reach the user even after they closed the tab. This package only
 * defines the seam — real channels (push, email, desktop) are an app-layer concern.
 */
export interface NotificationSink {
  notify(notification: JobNotification): void | Promise<void>;
}

/** Collects notifications in memory — for tests, and for a dev app layer. */
export class InMemoryNotificationSink implements NotificationSink {
  readonly sent: JobNotification[] = [];

  notify(notification: JobNotification): void {
    this.sent.push(notification);
  }
}
