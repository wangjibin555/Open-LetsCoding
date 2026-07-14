// 可推送的 AsyncIterable：作为 query() 的流式输入（streaming input mode），
// 使 interrupt() / setModel() / 多轮 send 在同一会话进程内可用。
export class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = []
  private resolvers: Array<(r: IteratorResult<T>) => void> = []
  private done = false

  push(value: T): void {
    if (this.done) return
    const resolve = this.resolvers.shift()
    if (resolve) resolve({ value, done: false })
    else this.queue.push(value)
  }

  end(): void {
    this.done = true
    for (const resolve of this.resolvers.splice(0)) {
      resolve({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift() as T, done: false })
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as never, done: true })
        }
        return new Promise((resolve) => this.resolvers.push(resolve))
      }
    }
  }
}
