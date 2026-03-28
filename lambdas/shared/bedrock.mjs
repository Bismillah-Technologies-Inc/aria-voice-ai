import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

let client;

function getClient() {
  if (!client) {
    client = new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION || 'us-east-1' });
  }
  return client;
}

/**
 * Invoke a Bedrock model with a prompt.
 * @param {string} prompt - The user message content
 * @param {object} options
 * @param {string} [options.modelId] - Bedrock model ID (defaults to BEDROCK_MODEL_ID env var)
 * @param {number} [options.maxTokens=512] - Max tokens to generate
 * @param {number} [options.temperature=0] - Temperature for generation
 * @param {string} [options.systemPrompt] - Optional system prompt
 * @returns {string} The model's text response
 */
export async function invokeModel(prompt, {
  modelId = process.env.BEDROCK_MODEL_ID,
  maxTokens = 512,
  temperature = 0,
  systemPrompt = null,
} = {}) {
  const isNova = modelId?.startsWith('amazon.nova');
  const messages = isNova
    ? [{ role: 'user', content: [{ text: prompt }] }]
    : [{ role: 'user', content: prompt }];

  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    temperature,
    messages,
  };

  if (systemPrompt) {
    body.system = systemPrompt;
  }

  // Amazon Nova models use a different request format.
  const requestBody = isNova
    ? {
        messages,
        inferenceConfig: {
          maxTokens,
          temperature,
        },
        ...(systemPrompt ? { system: [{ text: systemPrompt }] } : {}),
      }
    : body;

  const command = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(requestBody),
  });

  const response = await getClient().send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));

  // Nova models return { output: { message: { content: [{ text }] } } }
  // Claude models return { content: [{ text }] }
  if (isNova) {
    return responseBody.output?.message?.content?.[0]?.text || '';
  }
  return responseBody.content?.[0]?.text || '';
}
