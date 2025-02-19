import { configuration } from '../configuration/configuration';
import { Mode, isVisualMode } from '../mode/mode';
import { PositionDiff } from './../common/motion/position';
import { Transformer } from './../transformations/transformer';
import { SpecialKeys } from '../util/specialKeys';
import type { VimState } from './vimState';
import { Position } from 'vscode';

/**
 * The RecordedState class holds the current action that the user is
 * doing. Example: Imagine that the user types:
 *
 * 5"qdw
 *
 * Then the relevant state would be
 *   * count of 5
 *   * copy into q register
 *   * delete operator
 *   * word movement
 *
 *
 * Or imagine the user types:
 *
 * vw$}}d
 *
 * Then the state would be
 *   * Visual mode action
 *   * (a list of all the motions you ran)
 *   * delete operator
 */
export class RecordedState {
  constructor() {
    this.registerName = configuration.useSystemClipboard ? '*' : '"';
  }

  /**
   * The keys the user has pressed that have not caused an action to be executed
   * yet and have not been stored on action keys. Used for command remapping.
   */
  public commandList: string[] = [];

  /**
   * String representation of the exact keys that the user entered.
   */
  public get commandString(): string {
    let result = '';

    if (this.actionsRun.length > 0) {
      result = this.actionsRunPressedKeys.join('');
    }
    if (this.actionKeys.length > 0) {
      // if there are any actionKeys waiting for other key append them
      result += this.actionKeys.join('');
    }
    if (this.bufferedKeys.length > 0) {
      // if there are any bufferedKeys waiting for other key append them
      result += this.bufferedKeys.join('');
    }
    if (
      this.actionsRun.length === 0 &&
      this.actionKeys.length === 0 &&
      this.bufferedKeys.length === 0 &&
      this.commandList.length > 0
    ) {
      // Used for the registers and macros that only record on commandList
      result = this.commandList.join('');
    }
    const regexEscape = new RegExp(/[|\\{}()[\]^$+*?.]/, 'g');
    const regexLeader = new RegExp(configuration.leader.replace(regexEscape, '\\$&'), 'g');
    const regexBufferedKeys = new RegExp(SpecialKeys.TimeoutFinished, 'g');
    result = result.replace(regexLeader, '<leader>').replace(regexBufferedKeys, '');

    return result;
  }

  /**
   * String representation of the pending keys that the user entered.
   */
  public get pendingCommandString(): string {
    let result = '';

    if (this.actionKeys.length > 0) {
      // if there are any actionKeys waiting for other key append them
      result += this.actionKeys.join('');
    }
    if (this.bufferedKeys.length > 0) {
      // if there are any bufferedKeys waiting for other key append them
      result += this.bufferedKeys.join('');
    }
    const regexEscape = new RegExp(/[|\\{}()[\]^$+*?.]/, 'g');
    const regexLeader = new RegExp(configuration.leader.replace(regexEscape, '\\$&'), 'g');
    const regexBufferedKeys = new RegExp(SpecialKeys.TimeoutFinished, 'g');
    result = result.replace(regexLeader, '<leader>').replace(regexBufferedKeys, '');

    return result;
  }

  /**
   * Determines if the current command list is prefixed with a count
   */
  public get commandWithoutCountPrefix() {
    return this.commandList.join('').replace(/^[0-9]+/g, '');
  }

  /**
   * Reset the command list.
   */
  public resetCommandList() {
    this.commandList = [];
  }

  /**
   * Keeps track of keys pressed for the next action. Comes in handy when parsing
   * multiple length movements, e.g. gg.
   */
  public actionKeys: string[] = [];

  /**
   * Waiting for another key for a potential action.
   *
   * Used to prevent the remapping of keys after a potential action key
   * like @zZtTfF[]rm'`"gq<C-r><C-w>. This is done to be able to use all
   * the named registers and marks, even when the command with the same
   * name has been mapped.
   *
   * Vim Documentation: (:help map-error)
   * "Note that the second character (argument) of the commands @zZtTfF[]rm'`"v
   * and CTRL-X is not mapped. This was done to be able to use all the named
   * registers and marks, even when the command with the same name has been
   * mapped."
   *
   * The documentation only specifies some keys, but from testing pretty much
   * every key has this condition (keys like 'g', 'q', '<C-r>' and '<C-w>' all
   * behave the same) so here we use 'waitingForAnotherActionKey' to prevent
   * remapping on next keys. In the case of the 'v' key specified in the vim
   * documentation, I don't really understand what they mean with that because
   * it doesn't make much sense. The 'v' key puts you in Visual mode, it doesn't
   * accept any character argument.
   */
  public waitingForAnotherActionKey: boolean = false;

  /**
   * Every action that has been run.
   */
  public actionsRun: IBaseAction[] = [];

  /**
   * Keeps track of keys pressed by the actionsRun. Used for the showCmd. If an action
   * changes previous actions pressed keys it should change this list, like the <Del>
   * key after a number key.
   */
  public actionsRunPressedKeys: string[] = [];

  public getLastActionRun(): IBaseAction | undefined {
    if (this.actionsRun.length === 0) {
      return;
    }

    return this.actionsRun[this.actionsRun.length - 1];
  }

  /**
   * Every key that was buffered to wait for a new key or the timeout to finish
   * in order to get another potential remap or to solve an ambiguous remap.
   */
  public bufferedKeys: string[] = [];
  public bufferedKeysTimeoutObj: NodeJS.Timeout | undefined = undefined;

  /**
   * This is used when the remappers are resending the keys after a potential
   * remap without an ambiguous remap is broken, either by a new key or by the
   * timeout finishing.
   *
   * It will make it so the first key sent will not be considered as a potential
   * remap by any of the remappers, even though it is, to prevent the remappers
   * of doing the same thing again. This way the first key will be handled as an
   * action but the next keys can still be remapped.
   *
   * Example: if you map `iiii -> i<C-A><Esc>` in normal mode and map `ii -> <Esc>`
   * in insert mode, after pressing `iii` you want the first `i` to put you in
   * insert mode and the next `ii` to escape to normal mode.
   */
  public allowPotentialRemapOnFirstKey = true;

  public hasRunOperator = false;

  /**
   * This is kind of a hack and should be associated with something like this:
   *
   * https://github.com/VSCodeVim/Vim/issues/805
   */
  public operatorPositionDiff: PositionDiff | undefined;

  public isInsertion = false;

  /**
   * The text transformations that we want to run. They will all be run after the action has been processed.
   *
   * Running an individual action will generally queue up to one of these, but if you're in
   * multi-cursor mode, you'll queue one per cursor, or more.
   *
   * Note that the text transformations are run in parallel. This is useful in most cases,
   * but will get you in trouble in others.
   */
  public transformer = new Transformer();

  /**
   * The operator (e.g. d, y, >) the user wants to run, if there is one.
   */
  public get operator(): IBaseOperator | undefined {
    const operators = this.operators;
    return operators.length > 0 ? operators[0] : undefined;
  }

  public get operators(): IBaseOperator[] {
    return this.actionsRun.filter((a): a is IBaseOperator => a.isOperator).reverse();
  }

  /**
   * The command (e.g. i, ., R, /) the user wants to run, if there is one.
   */
  public get command(): IBaseCommand {
    const list = this.actionsRun.filter((a): a is IBaseCommand => a.isCommand).reverse();

    // TODO - disregard <Esc>, then assert this is of length 1.

    return list[0];
  }

  public get hasRunAMovement(): boolean {
    return this.actionsRun.some((a) => a.isMotion);
  }

  /**
   * The number of times the user wants to repeat this action.
   */
  public count: number = 0;

  /**
   * The number of times the user wants to repeat the operator. If after the operator the user
   * uses a motion with count that count will be multiplied by this count.
   *
   * Example: if user presses 2d3w it deletes 6 words.
   */
  public operatorCount: number = 0;

  /**
   * The register name for this action.
   */
  public registerName: string;

  /**
   * The key used to access the register with `registerName`
   * Example: if 'q5' then key=5 and name=5
   * Or:      if 'qA' then key=A and name=a
   */
  public registerKey: string = '';

  public clone(): RecordedState {
    const res = new RecordedState();

    // TODO: Actual clone.

    res.actionKeys = this.actionKeys.slice(0);
    res.actionsRun = this.actionsRun.slice(0);
    res.hasRunOperator = this.hasRunOperator;

    return res;
  }

  public operatorReadyToExecute(mode: Mode): boolean {
    // Visual modes do not require a motion -- they ARE the motion.
    return (
      this.operator !== undefined &&
      !this.hasRunOperator &&
      mode !== Mode.SearchInProgressMode &&
      mode !== Mode.CommandlineInProgress &&
      (this.hasRunAMovement ||
        isVisualMode(mode) ||
        (this.operators.length > 1 &&
          this.operators.reverse()[0].constructor === this.operators.reverse()[1].constructor))
    );
  }

  public isOperatorPending(mode: Mode): boolean {
    // Visual modes do not require a motion -- they ARE the motion.
    return (
      this.operator !== undefined &&
      !this.hasRunOperator &&
      mode !== Mode.SearchInProgressMode &&
      mode !== Mode.CommandlineInProgress &&
      !(
        this.hasRunAMovement ||
        isVisualMode(mode) ||
        (this.operators.length > 1 &&
          this.operators.reverse()[0].constructor === this.operators.reverse()[1].constructor)
      )
    );
  }
}

export interface IBaseAction {
  isMotion: boolean;
  isOperator: boolean;
  isCommand: boolean;
  isJump: boolean;
  canBeRepeatedWithDot: boolean;

  keysPressed: string[];
  multicursorIndex: number | undefined;

  preservesDesiredColumn(): boolean;
}

export interface IBaseCommand extends IBaseAction {
  exec(position: Position, vimState: VimState): Promise<void>;
}

export interface IBaseOperator extends IBaseAction {
  run(vimState: VimState, start: Position, stop: Position): Promise<void>;
  runRepeat(vimState: VimState, position: Position, count: number): Promise<void>;
}
