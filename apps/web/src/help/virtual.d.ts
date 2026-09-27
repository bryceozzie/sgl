/** `build/help-plugin.ts`'s virtual module (DD-13 P13): the compiled help content. */
declare module 'virtual:sgl-help-content' {
  const content: import('./content.js').HelpContent;
  export default content;
}
