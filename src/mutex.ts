// Runs async tasks one at a time, in call order. A failed task does not
// block the tasks queued after it.
export class Mutex {
  // Settles when the last queued task settles. Never rejects.
  private tail: Promise<void> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => task())
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
