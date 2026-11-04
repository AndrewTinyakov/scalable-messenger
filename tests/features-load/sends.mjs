export class SendSchedule {
  constructor({ rate, total, metrics, create, dispatch, limit = 64 }) {
    Object.assign(this, { rate, total, metrics, create, dispatch, limit });
    this.startAt = 0;
    this.nextOffered = 0;
    this.pending = [];
    this.peakPending = 0;
  }
  tick(now, complete = false) {
    this.flush(now);
    const due = complete ? this.total : Math.min(this.total, Math.floor(Math.max(0, now - this.startAt) * this.rate / 1000) + 1);
    const offered = Math.max(0, due - this.nextOffered);
    const admitted = Math.min(offered, this.limit - this.pending.length);
    this.metrics.count('send.offered', offered);
    for (let offset = 0; offset < admitted; offset++) {
      const index = this.nextOffered + offset;
      this.pending.push(this.create(index, this.startAt + index * 1000 / this.rate));
    }
    const dropped = offered - admitted;
    if (dropped) {
      this.metrics.count('send.dropped', dropped);
      this.metrics.count('send.backlogOverflow', dropped);
    }
    this.nextOffered += offered;
    this.peakPending = Math.max(this.peakPending, this.pending.length);
    this.flush(now);
  }
  flush(now) {
    const retained = [];
    for (const record of this.pending) {
      if (this.dispatch(record)) {
        this.metrics.observe('send.schedulingLag', Math.max(0, now - record.scheduledAt));
      } else {
        this.metrics.count('send.admissionBlockedAttempts');
        if (!record.deferred) { record.deferred = true; this.metrics.count('send.deferred'); }
        retained.push(record);
      }
    }
    this.pending = retained;
  }
  expire() {
    if (this.pending.length) {
      this.metrics.count('send.dropped', this.pending.length);
      this.metrics.count('send.backlogExpired', this.pending.length);
      this.pending = [];
    }
  }
  report() { return { offered: this.nextOffered, pending: this.pending.length, peakPending: this.peakPending, limit: this.limit }; }
}
