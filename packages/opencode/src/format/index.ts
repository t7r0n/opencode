import { Effect, Layer, ServiceMap } from "effect"
import { runPromiseInstance } from "@/effect/runtime"
import { InstanceContext } from "@/effect/instance-context"
import path from "path"
import { mergeDeep } from "remeda"
import z from "zod"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Process } from "../util/process"
import { Log } from "../util/log"
import * as Formatter from "./formatter"

export namespace Format {
  const log = Log.create({ service: "format" })

  export const Status = z
    .object({
      name: z.string(),
      extensions: z.string().array(),
      enabled: z.boolean(),
    })
    .meta({
      ref: "FormatterStatus",
    })
  export type Status = z.infer<typeof Status>

  export interface Interface {
    readonly run: (filepath: string) => Effect.Effect<void>
    readonly status: () => Effect.Effect<Status[]>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Format") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const instance = yield* InstanceContext

      const cache: Record<string, string[] | false> = {}
      const formatters: Record<string, Formatter.Info> = {}

      const cfg = yield* Effect.promise(() => Config.get())

      if (cfg.formatter === false) {
        log.info("all formatters are disabled")
      }

      if (cfg.formatter !== false) {
        for (const item of Object.values(Formatter)) {
          formatters[item.name] = item
        }

        for (const [name, item] of Object.entries(cfg.formatter ?? {})) {
          if (item.disabled) {
            delete formatters[name]
            continue
          }

          const result: Formatter.Info = mergeDeep(formatters[name] ?? {}, {
            extensions: [],
            ...item,
          })

          result.enabled = async () => item.command ?? false
          result.name = name
          formatters[name] = result
        }
      }

      async function resolve(item: Formatter.Info) {
        let command = cache[item.name]
        if (command === undefined) {
          log.info("resolving command", { name: item.name })
          command = await item.enabled()
          cache[item.name] = command
        }
        return command
      }

      async function get(ext: string) {
        const result: { info: Formatter.Info; command: string[] }[] = []
        for (const item of Object.values(formatters)) {
          if (!item.extensions.includes(ext)) continue
          const command = await resolve(item)
          if (!command) continue
          log.info("enabled", { name: item.name, ext })
          result.push({ info: item, command })
        }
        return result
      }

      const run = Effect.fn("Format.run")(function* (filepath: string) {
        log.info("formatting", { file: filepath })
        const ext = path.extname(filepath)

        for (const item of yield* Effect.promise(() => get(ext))) {
          log.info("running", { command: item.command })
          yield* Effect.tryPromise({
            try: async () => {
              const proc = Process.spawn(
                item.command.map((x) => x.replace("$FILE", filepath)),
                {
                  cwd: instance.directory,
                  env: { ...process.env, ...item.info.environment },
                  stdout: "ignore",
                  stderr: "ignore",
                },
              )
              const exit = await proc.exited
              if (exit !== 0) {
                log.error("failed", {
                  command: item.command,
                  ...item.info.environment,
                })
              }
            },
            catch: (error) => {
              log.error("failed to format file", {
                error,
                command: item.command,
                ...item.info.environment,
                file: filepath,
              })
              return error
            },
          }).pipe(Effect.ignore)
        }
      })

      log.info("init")

      const status = Effect.fn("Format.status")(function* () {
        const result: Status[] = []
        for (const formatter of Object.values(formatters)) {
          const command = yield* Effect.promise(() => resolve(formatter))
          result.push({
            name: formatter.name,
            extensions: formatter.extensions,
            enabled: !!command,
          })
        }
        return result
      })

      return Service.of({ run, status })
    }),
  )

  export async function run(filepath: string) {
    return runPromiseInstance(Service.use((s) => s.run(filepath)))
  }

  export async function status() {
    return runPromiseInstance(Service.use((s) => s.status()))
  }
}
