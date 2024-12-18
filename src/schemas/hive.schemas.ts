import z from 'zod'
import type {CoreMessage, LanguageModelV1} from 'ai'
import {openai} from '@ai-sdk/openai'
import {Agent} from '../agent.ts'
import {jsonValueSchema} from './common.schemas.ts'
import type {SwarmMessage} from '../types.ts'

export const hiveOptionsSchema = z.object({
    defaultLanguageModel: z.custom<LanguageModelV1>()
        .default(openai('gpt-4o-mini'))
        .describe('The default language model for the swarm; used if you do not specify one for the agent.'),
    queen: z.custom<Agent>((agent) => agent instanceof Agent)
        .describe('The "entrypoint" agent to the swarm, often your "router" or "orchestrator" agent.'),
    defaultContext: z.record(z.string(), jsonValueSchema)
        .default({})
        .describe('Context variables for the swarm'),
})

export type HiveOptions = z.infer<typeof hiveOptionsSchema>

export const hiveCreateSwarmOptionsSchema = z.object({
    defaultLanguageModel: z.custom<LanguageModelV1>()
        .optional()
        .describe('The default language model for the swarm; used if you do not specify one for the agent.'),
    messages: z.array(z.custom<SwarmMessage>())
        .optional()
        .describe('The messages in the conversation'),
    leader: z.custom<Agent>((agent) => agent instanceof Agent, 'Swarm leader must be an agent!')
        .optional()
        .describe('The "entrypoint" agent to the swarm, often your "router" or "orchestrator" agent.'),
    updatedContext: z.record(z.string(), jsonValueSchema)
        .default({})
        .describe('Context variables for the swarm'),
})

export type HiveCreateSwarmOptions = z.infer<typeof hiveCreateSwarmOptionsSchema>