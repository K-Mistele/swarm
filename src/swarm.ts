import z from 'zod'
import type {
    CoreTool,
    LanguageModel,
    ToolExecutionOptions,
    CoreAssistantMessage,
    CoreSystemMessage,
    CoreUserMessage,
    CoreToolMessage,
    CoreMessage,
    UserContent,
    GenerateTextResult,
    StepResult,
    ToolResultPart,
    StreamTextResult,
    TextStreamPart,
    FinishReason
} from 'ai'
import {tool, generateText, streamText} from 'ai'
import {Agent, type AgentHandoverTool, type AgentTool} from './agent'
import {
    createAsyncIterableStream,
    createResolvablePromise,
    createStitchableStream,
    type EnrichedStreamPart,
    type ExtendedEnrichedStreamPart,
    type ExtendedTextStreamPart,
    type JSONSerializableObject
} from './utils'
import {openai} from '@ai-sdk/openai'

const SWARM_CONTEXT_PROPERTY_NAME = 'swarmContext'

export type SwarmMessage = (CoreAssistantMessage & { sender?: string }) |
    CoreUserMessage |
    CoreToolMessage |
    CoreSystemMessage

export type SwarmOptions<SWARM_CONTEXT extends object = JSONSerializableObject> = {
    defaultModel?: LanguageModel
    queen: Agent<SWARM_CONTEXT>
    initialContext: SWARM_CONTEXT
    messages?: Array<SwarmMessage>
    name?: string
    maxTurns?: number
    returnToQueen?: boolean // should control of the swarm be returned to the queen post-completion?
}

/**
 * Invoke the swarm to handle a user message
 */
export type BaseSwarmInvocationOptions<SWARM_CONTEXT extends object = JSONSerializableObject> = {
    contextUpdate?: Partial<SWARM_CONTEXT>
    setAgent?: Agent<SWARM_CONTEXT>
    maxTurns?: number
    returnToQueen?: boolean // should control of the swarm be returned to the queen post-completion?
    onStepFinish?: (event: StepResult<any>, context: SWARM_CONTEXT) => Promise<void> | void;
}

type SwarmInvocationWithContent = {
    content: UserContent,
    messages?: undefined
}

type SwarmInvocationWithMessages = {
    content?: undefined
    messages: Array<SwarmMessage>
}

export type SwarmInvocationOptions<SWARM_CONTEXT extends object> = BaseSwarmInvocationOptions<SWARM_CONTEXT> & (
    SwarmInvocationWithContent |
    SwarmInvocationWithMessages
    )

export type SwarmStreamingOptions = {
    experimental_toolCallStreaming?: boolean
}

/**
 * The swarm is the callable that can generate text, generate objects, or stream text.
 */
export class Swarm<SWARM_CONTEXT extends object = any> {

    readonly defaultModel: LanguageModel
    readonly name?: string
    public readonly queen: Agent<SWARM_CONTEXT>
    protected context: SWARM_CONTEXT
    protected messages: Array<SwarmMessage>
    protected readonly maxTurns: number
    protected readonly returnToQueen: boolean

    constructor(options: SwarmOptions<SWARM_CONTEXT>) {
        this.context = options.initialContext
        this.defaultModel = options.defaultModel || openai('gpt-4o-mini')
        this.queen = options.queen
        this._activeAgent = options.queen
        this.messages = options.messages || []
        this.name = options.name
        this.maxTurns = options.maxTurns || 100
        this.returnToQueen = !!options.returnToQueen
    }

    protected _activeAgent: Agent<SWARM_CONTEXT>

    public get activeAgent() {
        return this._activeAgent as Readonly<Agent<SWARM_CONTEXT>>
    }


    /**
     * Use the swarm to generate text / tool calls
     */
    public async generateText(options: SwarmInvocationOptions<SWARM_CONTEXT>) {

        // handle any swarm updates & overrides based on the user input - active agent, messages, etc
        this.handleUpdatesAndOverrides(options)

        const initialMessages: Array<CoreMessage> = options.messages
            ? this.messages
            : [
                ...this.messages,
                {role: 'user', content: options.content}
            ]

        // Can generate prompt instead too
        let lastResult: GenerateTextResult<any, any>
        const responseMessages: Array<SwarmMessage> = []

        const maxTotalSteps = options.maxTurns ?? this.maxTurns
        do {

            const initialAgent = this._activeAgent

            // Run the LLM generation.
            lastResult = await generateText({
                model: this._activeAgent.config.model || this.defaultModel,
                system: this._activeAgent.getInstructions(this.context),
                tools: this.wrapTools(this._activeAgent.tools), // Wrap tools to hide the swarmContext from the LLM; it
                                                                // will be passed once the LLM invokes the tools
                maxSteps: this._activeAgent.config.maxTurns ?? maxTotalSteps,
                // @ts-expect-error
                toolChoice: this._activeAgent.config.toolChoice,
                onStepFinish: options.onStepFinish
                    ? (stepResult) => options.onStepFinish!(
                        stepResult,
                        this.context
                    )
                    : undefined,
                messages: [...initialMessages, ...responseMessages]
            })

            // On completion, add messages with name of current assistant
            responseMessages.push(...lastResult.response.messages.map(message => ({
                ...message,
                sender: this._activeAgent.name
            })))

            // if the current agent generates text, we are done -- it's presenting an answer, so break
            if (['stop', 'length', 'content-filter', 'error'].includes(lastResult.finishReason)) {
                // we're done, the model generated text
                break
            }

            // Find unhandled tool calls by looking for a call with an ID that is not included in the tool call results
            const {toolCalls, toolResults} = lastResult
            const toolResultIds = toolResults.map(result => result.toolCallId)
            const unhandledToolCalls = toolCalls.filter(
                toolCall => !toolResultIds.includes(toolCall.toolCallId)
            )

            // Find handover calls - a tool call _without_ a result and whose "unwrapped" form that the agent has
            //  indicates "type": "handover"
            const handoverCalls = unhandledToolCalls.filter(
                toolCall => this._activeAgent.tools?.[toolCall.toolName].type === 'handover'
            )

            // So, if we haven't generated text or errored and we're here, that merans that execution either stopped
            //  Because of an agent transfer, which we already handled, OR because the agent ran out of max steps

            // Process handover calls; although we only look at the first one if the agent
            let handoverToolResult: ToolResultPart | undefined;
            if (handoverCalls.length > 0) {

                // Get the _originally_ defined handover tool from the agent's tool list; i.e. the unwrapped tool
                const handoverTool = this._activeAgent.tools?.[
                    handoverCalls[0].toolName
                    ]! as AgentHandoverTool<SWARM_CONTEXT, any>

                // Execute the handover tool with the arguments generated by the LLM, _and_ the current context
                const result = await handoverTool.execute({
                    ...handoverCalls[0].args,
                    ...this.context
                }, {})

                // Based on the results of executing the user-supplied handover tool with the LLM-generated args and
                // context, update the active agent and update the context IFF a context update was specified
                this._activeAgent = result.agent
                if (result.context) this.context = {
                    ...this.context,
                    ...result.context
                }

                // Generate an "artificial" handover tool result to add to the history
                handoverToolResult = {
                    type: 'tool-result',
                    toolCallId: handoverCalls[0].toolCallId,
                    toolName: handoverCalls[0].toolName,
                    result: `Handing over to agent ${this._activeAgent.name}`
                }
            }

            // locate the assistant message for the tool call, and the tool-role tool response message
            const toolMessage = responseMessages.at(-1)?.role === 'tool'
                ? (responseMessages.at(-1) as CoreToolMessage)
                : undefined
            const assistantMessage = responseMessages.at(
                toolMessage === undefined ? -1 : -2
            ) as CoreAssistantMessage

            // if we created a handover tool result for a handover -- i.e. if there was a handover
            if (handoverToolResult != null) {

                // If there is NO tool result message (because there was no executor) then we add a tool-result message
                //  that contains the handover tool result
                if (toolMessage == null) {
                    responseMessages.push({role: 'tool', content: [handoverToolResult]})
                }
                    // If there IS a tool result message (e.g. if there was a call and THEN a handover, add the handover
                //  result to the existing message.
                else {
                    toolMessage.content.push(handoverToolResult)
                }
            }

            // clean out unused tool calls
            if (typeof assistantMessage.content !== 'string') {
                const unusedToolCallIds = handoverCalls
                    .filter((call, index) => index > 0)
                    .map(call => call.toolCallId)

                assistantMessage.content = assistantMessage.content.filter(part => {
                    return part.type === 'tool-call'
                        ? !unusedToolCallIds.includes(part.toolCallId)
                        : true
                })
            }

            // So, if we haven't generated text or errored and we're here, that merans that execution either stopped
            //  Because of an agent transfer, which we already handled, OR because the agent ran out of max steps
            const assistantMessages = lastResult.response.messages.filter(message => message.role === 'assistant')
            if (
                initialAgent.config.maxTurns &&
                initialAgent.config.maxTurns === assistantMessages.length &&
                responseMessages.filter(message => message.role === 'assistant').length < maxTotalSteps
            ) {
                this._activeAgent = this.queen
            }
        }
        while (
            responseMessages.filter(message => message.role === 'assistant').length < maxTotalSteps
            )

        // update history
        this.messages.push(...responseMessages)

        // TODO reset the current agent to the queen, if requested.
        if (this.returnToQueen) this._activeAgent = this.queen

        return {
            finishReason: lastResult.finishReason,
            activeAgent: this._activeAgent,
            text: lastResult.text,
            messages: responseMessages,
            context: this.context
        }
    }

    /**
     * Stream from the swarm
     * @param options
     */
    public streamText(options: SwarmInvocationOptions<SWARM_CONTEXT> & SwarmStreamingOptions) {


        // swarm updates and overrides
        this.handleUpdatesAndOverrides(options)
        const initialMessages: Array<CoreMessage> = options.messages
            ? this.messages
            : [
                ...this.messages,
                {role: 'user', content: options.content}
            ]

        // Create promises that will be returned immediately and then resolved as soon as everything is available
        const finishReasonPromise = createResolvablePromise<FinishReason>()
        const activeAgentPromise = createResolvablePromise<Readonly<Agent>>()
        const textPromise = createResolvablePromise<string>()
        const allResponseMessagesPromise = createResolvablePromise<Array<SwarmMessage>>()
        const contextPromise = createResolvablePromise<SWARM_CONTEXT>()

        // Set up a stream that can have other streams stitched into it
        let stitchableStream = createStitchableStream<ExtendedTextStreamPart<any> | TextStreamPart<any>>()
        let stream = stitchableStream.stream
        let addStream = stitchableStream.addStream
        let closeStream = stitchableStream.close
        let enqueue = stitchableStream.enqueue

        // Function to split the stream
        function teeStream() {
            const [stream1, stream2] = stream.tee()
            stream = stream2
            return stream1
        }

        // Create a copy of the stream that's ONLY text, no tool calls. each streamed thing is just text.
        const textStream = createAsyncIterableStream(teeStream().pipeThrough(
            new TransformStream<EnrichedStreamPart<any, any>['part']>({
                transform: (streamPart, controller) => {
                    if (streamPart?.type === 'text-delta') {
                        controller.enqueue(streamPart.textDelta)
                    }
                    else if (streamPart?.type === 'error') {
                        controller.error(streamPart.error)
                    }
                }
            })
        ))

        // Create a copy of the stream that's everything generated by the stream; also adds the agent info
        // so client code can tell which agent is streaming.
        const fullStream = createAsyncIterableStream(teeStream().pipeThrough(
            new TransformStream<
                ExtendedEnrichedStreamPart<any, any>['part'] | EnrichedStreamPart<any, any>['part'],
                ExtendedTextStreamPart<any>
            >({
                transform: (streamPart, controller) => {
                    if ('agent' in streamPart) controller.enqueue(streamPart);
                    else controller.enqueue({
                        ...streamPart,
                        agent: {
                            id: this._activeAgent.uuid,
                            name: this._activeAgent.name
                        }
                    });
                },
            }),
        ));


        // Inline an async function so we can handle generation and streaming in the background but return immediately
        (async () => {
            let lastResult: StreamTextResult<any>
            const responseMessages: Array<SwarmMessage> = []
            const maxTotalSteps = options.maxTurns ?? this.maxTurns;

            do {
                const initialAgent = this._activeAgent
                // Run generation
                lastResult = streamText({
                    model: this._activeAgent.config.model || this.defaultModel,
                    system: this._activeAgent.getInstructions(this.context),
                    tools: this.wrapTools(this._activeAgent.tools),
                    maxSteps: this._activeAgent.config.maxTurns ?? maxTotalSteps,
                    // @ts-expect-error
                    toolChoice: this._activeAgent.config.toolChoice,
                    onStepFinish: options.onStepFinish
                        ? (stepResult) => options.onStepFinish!(
                            stepResult,
                            this.context
                        )
                        : undefined,
                    messages: [...initialMessages, ...responseMessages],
                    experimental_toolCallStreaming: !(options.experimental_toolCallStreaming === false)
                });

                // It returns instantly, so add the stream, then await the response to be generated
                addStream(lastResult.fullStream)

                // add messages once finished
                const [response, finishReason, toolResults, toolCalls] = await Promise.all([
                    lastResult.response,
                    lastResult.finishReason,
                    lastResult.toolResults,
                    lastResult.toolCalls
                ])

                responseMessages.push(...response.messages.map(message => ({
                    ...message,
                    sender: this._activeAgent.name
                })))

                // If the current agent generates text, we are done -- it's presenting an answer, so break
                if (['stop', 'length', 'content-filter', 'error'].includes(finishReason)) {
                    break;
                }

                // find unhandled calls by looking for a call with an ID that is not included int he tool call result
                const toolResultIds = toolResults.map(result => result.toolCallId)
                const unhandledToolCalls = toolCalls.filter(
                    toolCall => !toolResultIds.includes(toolCall.toolCallId)
                )

                // Find handover calls - a tool call _without_ a result and whose "unwrapped" form that the agent has
                //  indicates "type": "handover"
                const handoverCalls = unhandledToolCalls.filter(
                    toolCall => this._activeAgent.tools?.[toolCall.toolName].type === 'handover'
                )

                // So, if we haven't generated text or errored and we're here, that merans that execution either stopped
                //  Because of an agent transfer, which we already handled, OR because the agent ran out of max steps

                // Process handover calls; although we only look at the first one if the agent
                let handoverToolResult: Extract<ExtendedTextStreamPart<any>, {type: 'tool-result'}> | undefined = undefined
                if (handoverCalls.length > 0) {

                    // Get the _originally_ defined handover tool from the agent's tool list; i.e. the unwrapped tool
                    const handoverTool = this._activeAgent.tools?.[
                        handoverCalls[0].toolName
                        ]! as AgentHandoverTool<SWARM_CONTEXT, any>

                    // save the previous agent's information for the stream delta
                    const previousAgent = {name: this._activeAgent.name, id: this._activeAgent.uuid}
                    // Execute the handover tool with the arguments generated by the LLM, _and_ the current context
                    const result = await handoverTool.execute({
                        ...handoverCalls[0].args,
                        ...this.context
                    }, {})

                    // Based on the results of executing the user-supplied handover tool with the LLM-generated args and
                    // context, update the active agent and update the context IFF a context update was specified
                    this._activeAgent = result.agent
                    if (result.context) this.context = {
                        ...this.context,
                        ...result.context
                    }

                    // Generate an "artificial" handover tool result to add to the history
                    handoverToolResult = {
                        type: 'tool-result',
                        toolCallId: handoverCalls[0].toolCallId,
                        toolName: handoverCalls[0].toolName,
                        result: `Handing over to agent ${this._activeAgent.name}`,
                        handedOverTo: {
                            id: this._activeAgent.uuid,
                            name: this._activeAgent.name
                        },
                        args: handoverCalls[0].args,
                        agent: previousAgent
                    } satisfies ExtendedTextStreamPart<any>
                    // push the tool result into the stream
                    enqueue(handoverToolResult)
                }

                // locate the assistant message for the tool call, and the tool-role tool response message
                const toolMessage = responseMessages.at(-1)?.role === 'tool'
                    ? (responseMessages.at(-1) as CoreToolMessage)
                    : undefined
                const assistantMessage = responseMessages.at(
                    toolMessage === undefined ? -1 : -2
                ) as CoreAssistantMessage

                // if we created a handover tool result for a handover -- i.e. if there was a handover
                if (handoverToolResult) {

                    // If there is NO tool result message (because there was no executor) then we add a tool-result
                    // message that contains the handover tool result
                    if (toolMessage == null) {
                        responseMessages.push({role: 'tool', content: [handoverToolResult]})
                    }
                        // If there IS a tool result message (e.g. if there was a call and THEN a handover, add the
                        // handover
                    //  result to the existing message.
                    else {
                        toolMessage.content.push(handoverToolResult)
                    }
                }

                // clean out unused tool calls
                if (typeof assistantMessage.content !== 'string') {
                    const unusedToolCallIds = handoverCalls
                        .filter((call, index) => index > 0)
                        .map(call => call.toolCallId)

                    assistantMessage.content = assistantMessage.content.filter(part => {
                        return part.type === 'tool-call'
                            ? !unusedToolCallIds.includes(part.toolCallId)
                            : true
                    })
                }

                // So, if we haven't generated text or errored and we're here, that merans that execution either stopped
                //  Because of an agent transfer, which we already handled, OR because the agent ran out of max steps
                const assistantMessages = response.messages.filter(message => message.role === 'assistant')
                if (
                    initialAgent.config.maxTurns &&
                    initialAgent.config.maxTurns === assistantMessages.length &&
                    responseMessages.filter(message => message.role === 'assistant').length < maxTotalSteps
                ) {
                    this._activeAgent = this.queen
                }

            }
            while (responseMessages.filter(message => message.role === 'assistant').length < maxTotalSteps)
            closeStream() // close the open stream

            // update history
            this.messages.push(...responseMessages)

            // return to queen if requested
            if (this.returnToQueen) this._activeAgent = this.queen

            // Resolve the promises we set earlier
            lastResult.finishReason.then(reason => finishReasonPromise.resolve(reason))
            activeAgentPromise.resolve(this._activeAgent as Readonly<Agent>)
            lastResult.text.then(text => textPromise.resolve(text))
            allResponseMessagesPromise.resolve(responseMessages)
            contextPromise.resolve(this.context)

        })()

        // TODO make sure you resolve these promises.
        return {
            finishReason: finishReasonPromise.promise,
            activeAgent: activeAgentPromise.promise,
            text: textPromise.promise,
            messages: allResponseMessagesPromise.promise,
            context: contextPromise.promise,
            textStream: textStream,
            fullStream: fullStream
        }

    }

    /**
     * Return a read-only version of the context
     */
    public getContext() {
        return this.context as Readonly<SWARM_CONTEXT>
    }

    /**
     * Update context, and receive a readonly version of it.
     * @param update
     */
    public updateContext(update: Partial<SWARM_CONTEXT>) {
        this.context = {
            ...this.context,
            ...update
        }
        return this.context as Readonly<SWARM_CONTEXT>
    }

    /**
     * Handle updating and overriding models configurations based on invocation options
     * @param invocationOptions
     * @private
     */
    private handleUpdatesAndOverrides(invocationOptions: SwarmInvocationOptions<SWARM_CONTEXT>) {
        // Handle changing the active agent
        if (invocationOptions.setAgent) {
            this._activeAgent = invocationOptions.setAgent
        }

        if (invocationOptions.messages) {
            this.messages = invocationOptions.messages
        }
        // handle
        this.context = {
            ...this.context,
            ...invocationOptions.contextUpdate
        }
    }

    /**
     * wrap the agent's tools to hide the swarmContext property that they can request to get access to the swarm's
     * context; so that the LLM doesn't see it and try to generate it. this requires modifying the JSON schema, and
     * wrapping the executor.
     * @param tools
     * @private
     */
    private wrapTools(
        tools: Record<string, AgentTool<SWARM_CONTEXT>> | undefined
    ): Record<string, CoreTool> | undefined {

        if (!tools) return undefined

        // Map each tool into a CoreTool
        return Object.fromEntries(Object.entries(tools).map((
                [toolName, agentTool]: [string, AgentTool<SWARM_CONTEXT>]
            ): [string, CoreTool] => {


                let parameters: AgentTool<SWARM_CONTEXT>['parameters'] = agentTool.parameters
                let executor: CoreTool['execute'] = undefined;

                let functionWrapper: ((
                    args: z.infer<typeof parameters>,
                    options: ToolExecutionOptions
                ) => Promise<typeof agentTool.execute>) | undefined;

                // Wrap tool to handle context updates if the function requests it in the return
                if (agentTool.type === 'function') {
                    functionWrapper = async (
                        args: z.infer<typeof parameters>,
                        options: ToolExecutionOptions
                    ) => {

                        const {result, context} = await agentTool.execute(args, options)

                        if (context) this.context = {
                            ...this.context,
                            ...context
                        }
                        return result
                    }
                }


                // If the tool requests the swarm's context, we don't want the LLM to generate it,
                //  so strip it from the tool call parameters and wrap the executor

                if (SWARM_CONTEXT_PROPERTY_NAME in agentTool.parameters.shape) {
                    // Set the parameters for the tool so they omit the context; so that the LLM doesn't generate it
                    parameters = agentTool.parameters.omit({
                        [SWARM_CONTEXT_PROPERTY_NAME]: true
                    })

                    // if there's an executor, wrap it with an executor that only receives the LLM-generated arguments
                    //  (i.e. no context) and that then GETS the context of the swarm, and passed it along with the
                    //  LLM generated-params (so both LLM params and swarm context) to the original executor.
                    if (agentTool.execute) {
                        executor = async (
                            args: z.infer<typeof parameters>,
                            options: ToolExecutionOptions
                        ) => {

                            const swarmContext = this.getContext()
                            // Execute the agent tool with the arguments and the parameters
                            return functionWrapper
                                ? functionWrapper({
                                    ...args,
                                    [SWARM_CONTEXT_PROPERTY_NAME]: swarmContext
                                }, options)
                                : agentTool.execute!(
                                    {
                                        ...args,
                                        [SWARM_CONTEXT_PROPERTY_NAME]: swarmContext
                                    },
                                    options
                                )
                        }

                    }
                }
                else {
                    executor = functionWrapper
                }

                // If the tool type is handover, ensure there's no executor so that generation stops and we can
                // stop the agent; we will run it manually
                if (agentTool.type === 'handover') {
                    executor = undefined
                }

                // NOTE this looks more complicated (you'd think you could just pass an undefined executor) but you
                // cannot, so it has to be done this way.
            let wrappedTool: CoreTool
            if (executor) {
                wrappedTool = tool({
                    type: 'function',
                    description: agentTool.description,
                    parameters: parameters,
                    execute: executor
                })
            }
            else {
                wrappedTool = tool({
                    type: 'function',
                    description: agentTool.description,
                    parameters: parameters,
                })
            }
                return [toolName, wrappedTool]
            })
        )

    }

    public getMessages() {
        return this.messages as Readonly<Array<SwarmMessage>>
    }

}