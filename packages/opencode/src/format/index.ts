import { Effect, Layer, ServiceMap } from "effect"
import { runPromiseInstance } from "@/effect/runtime"
import { InstanceContext } from "@/effect/instance-context"
import path from "path"
import { mergeDeep } from "remeda"
import z from "zod"
import { Bus } from "../bus"
import { Config } from "../config/config"
import { File } from "../file"
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

      yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bus.subscribe(
            File.Event.Edited,
            Instance.bind(async (payload) => {
              const file = payload.properties.file
              log.info("formatting", { file })
              const ext = path.extname(file)

              for (const { info, command } of await get(ext)) {
                const replaced = command.map((x) => x.replace("$FILE", file))
                log.info("running", { replaced })
                try {
                  const proc = Process.spawn(replaced, {
                    cwd: instance.directory,
                    env: { ...process.env, ...info.environment },
                    stdout: "ignore",
                    stderr: "ignore",
                  })
                  const exit = await proc.exited
                  if (exit !== 0) {
                    log.error("failed", {
                      command,
                      ...info.environment,
                    })
                  }
                } catch (error) {
                  log.error("failed to format file", {
                    error,
                    command,
                    ...info.environment,
                    file,
                  })
                }
              }
            }),
          ),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      )
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

      return Service.of({ status })
    }),
  )

  export async function status() {
    return runPromiseInstance(Service.use((s) => s.status()))
  }
}
