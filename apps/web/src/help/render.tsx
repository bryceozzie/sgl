import type { ComponentChild } from 'preact';
import type { TextRun } from '@sgl/core';
import type { Block, ExampleSpec, List, Run, Token } from './content.js';
import { helpHref } from './links.js';

/**
 * The help content's renderer (DD-13 P13, §11): the compiled tree becomes
 * Preact elements, construct by construct. Text is always a text node, so
 * nothing is ever parsed as markup at run time: no `innerHTML`, no
 * `dangerouslySetInnerHTML`. Part of the lazy `help` chunk.
 *
 * Links (`#help/<id>`) keep their `href`, so they read and copy as links,
 * but a click is followed inside help (`onLink`), not by the browser.
 */

export type FollowLink = (id: string) => void;

function textRun(run: TextRun): ComponentChild {
  let node: ComponentChild = run.text;
  if (run.code === true) node = <code>{node}</code>;
  if (run.em === true) node = <em>{node}</em>;
  if (run.strong === true) node = <strong>{node}</strong>;
  return node;
}

export function Runs({ runs, onLink }: { readonly runs: readonly Run[]; readonly onLink: FollowLink }) {
  return (
    <>
      {runs.map((run) =>
        'link' in run ? (
          <a
            href={helpHref(run.link)}
            onClick={(ev) => {
              ev.preventDefault();
              onLink(run.link);
            }}
          >
            <Runs runs={run.runs} onLink={onLink} />
          </a>
        ) : (
          textRun(run)
        ),
      )}
    </>
  );
}

/** Highlighted code from the build's tokens (DD-13 P14): one span per token with a class. */
export function Code({ tokens }: { readonly tokens: readonly Token[] }) {
  return (
    <pre class="help-code">
      <code>{tokens.map(([cls, text]) => (cls === '' ? text : <span class={cls}>{text}</span>))}</code>
    </pre>
  );
}

function ListView({ list, onLink }: { readonly list: List; readonly onLink: FollowLink }) {
  const items = list.items.map((item) => (
    <li>
      <Runs runs={item.runs} onLink={onLink} />
      {item.sub !== undefined ? <ListView list={item.sub} onLink={onLink} /> : null}
    </li>
  ));
  return list.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
}

/** A body heading, one level below the entry's own title (an `h3`). */
function Heading({ level, children }: { readonly level: 1 | 2 | 3; readonly children: ComponentChild }) {
  const Tag = (['h4', 'h4', 'h5'] as const)[level - 1]!;
  return <Tag class="help-subheading">{children}</Tag>;
}

export interface BlocksProps {
  readonly blocks: readonly Block[];
  readonly onLink: FollowLink;
  /** How an `example` is shown (the drawer: code, preview and actions); without it, as its code. */
  readonly example?: (spec: ExampleSpec) => ComponentChild;
}

export function Blocks({ blocks, onLink, example }: BlocksProps) {
  return (
    <>
      {blocks.map((block) => {
        switch (block.type) {
          case 'heading':
            return (
              <Heading level={block.level}>
                <Runs runs={block.runs} onLink={onLink} />
              </Heading>
            );
          case 'paragraph':
            return (
              <p>
                <Runs runs={block.runs} onLink={onLink} />
              </p>
            );
          case 'list':
            return <ListView list={block} onLink={onLink} />;
          case 'code':
            return <Code tokens={block.tokens} />;
          case 'table':
            return (
              <div class="help-table">
                <table>
                  <thead>
                    <tr>
                      {block.head.map((cell) => (
                        <th scope="col">
                          <Runs runs={cell} onLink={onLink} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row) => (
                      <tr>
                        {row.map((cell) => (
                          <td>
                            <Runs runs={cell} onLink={onLink} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'note':
            return (
              <div class="help-note" role="note">
                <Blocks blocks={block.blocks} onLink={onLink} {...(example !== undefined && { example })} />
              </div>
            );
          case 'example': {
            const spec = block.example;
            if (spec.mode === 'example' && example !== undefined) return example(spec);
            return (
              <div class="help-snippet">
                {spec.title !== undefined ? <p class="help-snippet-title">{spec.title}</p> : null}
                <Code tokens={spec.tokens} />
              </div>
            );
          }
        }
      })}
    </>
  );
}
