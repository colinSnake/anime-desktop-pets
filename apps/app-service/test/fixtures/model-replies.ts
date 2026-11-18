import type { ModelProtocol } from '../../src/models/types.ts';
export const textReply = (protocol: ModelProtocol): unknown => ({
  'chat-completions': {choices:[{finish_reason:'stop',message:{role:'assistant',content:'合成回复'}}],usage:{prompt_tokens:4,completion_tokens:5}},
  responses: {status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'合成回复'}]}],usage:{input_tokens:4,output_tokens:5}},
  anthropic: {type:'message',role:'assistant',content:[{type:'text',text:'合成回复'}],stop_reason:'end_turn',usage:{input_tokens:4,output_tokens:5}},
  gemini: {candidates:[{finishReason:'STOP',content:{role:'model',parts:[{text:'合成回复'}]}}],usageMetadata:{promptTokenCount:4,candidatesTokenCount:5}},
})[protocol];
export const toolReply = (protocol: ModelProtocol): unknown => ({
  'chat-completions': {choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,reasoning_content:'private-signature',tool_calls:[{id:'call-one',type:'function',function:{name:'weather',arguments:'{"city":"合成"}'}}]}}]},
  responses: {status:'completed',output:[{id:'rs_private',type:'reasoning',encrypted_content:'private-signature',summary:[]},{id:'fc_private',type:'function_call',call_id:'call-one',name:'weather',arguments:'{"city":"合成"}'}]},
  anthropic: {type:'message',role:'assistant',content:[{type:'thinking',thinking:'do-not-display',signature:'private-signature'},{type:'tool_use',id:'call-one',name:'weather',input:{city:'合成'}}],stop_reason:'tool_use'},
  gemini: {candidates:[{finishReason:'STOP',content:{role:'model',parts:[{thought:true,text:'do-not-display',thoughtSignature:'private-signature'},{functionCall:{id:'call-one',name:'weather',args:{city:'合成'}},thoughtSignature:'private-signature'}]}}]},
})[protocol];
