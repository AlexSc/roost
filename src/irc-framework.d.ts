declare module 'irc-framework' {
  interface IrcFrameworkClient {
    requestCap(caps: string[]): void
    connect(opts: {
      host: string
      port: number
      nick: string
      username?: string
      gecos?: string
      auto_reconnect?: boolean
      auto_reconnect_max_retries?: number
    }): void
    join(channel: string): void
    part(channel: string): void
    say(target: string, text: string): void
    raw(...args: string[]): void
    whois(nick: string, callback: (event: { channels?: string }) => void): void
    quit(): void
    on(event: string, handler: (...args: unknown[]) => void): void
    connection: { write(data: string): void }
    network?: { cap?: { enabled?: string[]; available?: Map<string, string> } }
  }

  interface IrcNamespace {
    Client: new () => IrcFrameworkClient
  }

  const IRC: IrcNamespace
  export default IRC
}
