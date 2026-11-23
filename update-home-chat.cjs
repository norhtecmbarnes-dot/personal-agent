const fs = require('node:fs');
const file = 'src/App.tsx';
let s = fs.readFileSync(file, 'utf8');
const chatStart = s.indexOf('<section className="local-chat-card">');
const chatEnd = s.indexOf('</section>', chatStart) + '</section>'.length;
if (chatStart < 0 || chatEnd < chatStart) throw Error('Chat boundary missing');
let chat = s.slice(chatStart, chatEnd);
s = s.slice(0, chatStart) + s.slice(chatEnd);
const pickerStart = s.indexOf('<label className="field-label" htmlFor="local-model-choice">');
const pickerEnd = s.indexOf('</select>', pickerStart) + '</select>'.length;
if (pickerStart < 0 || pickerEnd < pickerStart) throw Error('Picker boundary missing');
let picker = s.slice(pickerStart, pickerEnd);
picker = picker.replace('setChatMessages([]); ', '').replace('disabled={!localModels.length && !ollamaCloudModels.length}', 'disabled={chatBusy || modelHealth === \'checking\' || (!localModels.length && !ollamaCloudModels.length)}');
s = s.slice(0, pickerStart) + '<p className="model-picker-help">Choose your active model on the front page, above chat.</p><button className="secondary-button" onClick={() => setTab(\'Overview\')}>Open chat & model picker →</button>' + s.slice(pickerEnd);
chat = chat.replace('<h2>Model chat</h2>', '<h2>Chat</h2>')
  .replace("connected ? `Talking to ${model.replace(/^Ollama · /, '')} on your device.` : 'Connect to Ollama to start local inference.'", "connected && model ? `Using ${model.replace(/^Ollama · /, '')} · ${/cloud/i.test(model) ? 'cloud inference through Ollama' : 'local inference on your device'}` : 'Choose a model above to start chatting.'")
  .replace('Send a message to test real local inference. Messages are kept in this page session.', 'What would you like to work on? Your conversation stays here while you explore the workspace.')
  .replace('Local model is generating…', 'Your selected model is responding…')
  .replace('disabled={!connected || chatBusy}', 'disabled={!connected || !model || chatBusy}')
  .replace('disabled={!connected || chatBusy || !chatInput.trim()}', 'disabled={!connected || !model || chatBusy || !chatInput.trim()}');
const controls = `<div className="home-chat-controls"><div className="home-model-field">${picker}</div><button className="secondary-button" onClick={() => void checkLocalModel()} disabled={chatBusy || modelHealth === 'checking'}>{modelHealth === 'checking' ? 'Checking…' : '↻ Refresh models'}</button><button className="text-button" onClick={() => setTab('Local models')}>Connection settings →</button><p className="model-status-line" role="status">{modelStatus}</p></div>`;
chat = chat.replace('<div className="local-chat-messages"', controls + '<div className="local-chat-messages"');
const overview = s.indexOf("{tab === 'Overview' && <>");
const insertAt = s.indexOf('</section>', overview) + '</section>'.length;
s = s.slice(0, insertAt) + '\n          ' + chat + s.slice(insertAt);
s = s.replace('Switch models in Local models. Local or cloud inference, as selected.', 'Choose your model above chat. Connection details are in Local models.')
  .replace('Check connection to load installed models, then select one below. This choice is used for chat and initializes the workflow model picker.', 'Manage your Ollama connection here. The active model dropdown and chat are on the front page.')
  .replace('<h2>Choose your active model</h2>', '<h2>Model connection</h2>')
  .replace('Choose an installed local Ollama model in Local models before chatting.', 'Choose an Ollama model above chat before sending a message.')
  .replace('Good afternoon<span className="wave"> ✳</span>', 'How can I help?<span className="wave"> ✳</span>');
fs.writeFileSync(file, s);
console.log('Moved chat and model picker to Overview; session state remains in App.');
