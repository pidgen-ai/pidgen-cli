import type { CommandSpec } from "../core/registry.js";
import { accountList } from "./account/list.js";
import { accountUse } from "./account/use.js";
import { apiCommands } from "./api/call.js";
import { authList } from "./auth/list.js";
import { authLogin } from "./auth/login.js";
import { authLogout } from "./auth/logout.js";
import { authRevoke } from "./auth/revoke.js";
import { authStatus } from "./auth/status.js";
import { doctor } from "./doctor/doctor.js";
import { contractAccept } from "./contract/accept.js";
import { contractCreate } from "./contract/create.js";
import { contractList } from "./contract/list.js";
import { contractPropose } from "./contract/propose.js";
import { contractPublish } from "./contract/publish.js";
import { contractRevise } from "./contract/revise.js";
import { contractShow } from "./contract/show.js";
import { domainArchive } from "./domain/archive.js";
import { domainCreate } from "./domain/create.js";
import { domainEdit } from "./domain/edit.js";
import { domainEpics } from "./domain/epics.js";
import { domainList } from "./domain/list.js";
import { domainMaintainerAdd } from "./domain/maintainer-add.js";
import { domainMaintainerRm } from "./domain/maintainer-rm.js";
import { domainMemberAdd } from "./domain/member-add.js";
import { domainMemberRm } from "./domain/member-rm.js";
import { domainParentAdd } from "./domain/parent-add.js";
import { domainParentRm } from "./domain/parent-rm.js";
import { domainProjectAdd } from "./domain/project-add.js";
import { domainProjectRm } from "./domain/project-rm.js";
import { domainShow } from "./domain/show.js";
import { domainUnarchive } from "./domain/unarchive.js";
import { epicCreate } from "./epic/create.js";
import { epicDagShow } from "./epic/dag-show.js";
import { epicEdgeAdd } from "./epic/edge-add.js";
import { epicEdgeRm } from "./epic/edge-rm.js";
import { epicEdit } from "./epic/edit.js";
import { epicList } from "./epic/list.js";
import { epicShow } from "./epic/show.js";
import { feedbackSend } from "./feedback/send.js";
import { intentList } from "./intent/list.js";
import { intentRespond } from "./intent/respond.js";
import { intentShow } from "./intent/show.js";
import { intentSubmit } from "./intent/submit.js";
import { intentWithdraw } from "./intent/withdraw.js";
import { manifestApply } from "./manifest/apply.js";
import { manifestTemplate } from "./manifest/template.js";
import { workerDoctor } from "./worker/doctor.js";
import { workerEnroll } from "./worker/enroll.js";
import { workerInstall } from "./worker/install.js";
import { workerStart } from "./worker/start.js";
import { workerStatus } from "./worker/status.js";
import { workerStop } from "./worker/stop.js";
import { workerSubscriptions, workerSubscriptionsUse } from "./worker/subscriptions.js";
import { workerUninstall } from "./worker/uninstall.js";
import { workerUpdate } from "./worker/update.js";
import { workerVerify } from "./worker/verify.js";
import { planApply } from "./plan/apply.js";
import { planCohorts } from "./plan/cohorts.js";
import { planPromote } from "./plan/promote.js";
import { planShow } from "./plan/show.js";
import { planTemplate } from "./plan/template.js";
import { projectList } from "./project/list.js";
import { projectShow } from "./project/show.js";
import { requestAccept } from "./request/accept.js";
import { requestAcknowledge } from "./request/acknowledge.js";
import { requestClose } from "./request/close.js";
import { requestList } from "./request/list.js";
import { requestPromote } from "./request/promote.js";
import { requestReply } from "./request/reply.js";
import { requestShow } from "./request/show.js";
import { requestSubmit } from "./request/submit.js";
import { reviewAttention } from "./review/attention.js";
import { reviewList } from "./review/list.js";
import { runList } from "./run/list.js";
import { runNodeOutput } from "./run/node-output.js";
import { runShow } from "./run/show.js";
import { sessionEditInstruction } from "./session/edit-instruction.js";
import { sessionInstructions } from "./session/instructions.js";
import { sessionSteer } from "./session/steer.js";
import { sessionWithdrawInstruction } from "./session/withdraw-instruction.js";
import { setup } from "./setup/setup.js";
import { skillsInstall } from "./skills/install.js";
import { skillsStatusCommand } from "./skills/status.js";
import { ticketAct } from "./ticket/act.js";
import { ticketActions } from "./ticket/actions.js";
import { ticketCancel } from "./ticket/cancel.js";
import { ticketClarify } from "./ticket/clarify.js";
import {
  ticketContractBuildsAgainst,
  ticketContractImplements,
  ticketContractRm,
} from "./ticket/contract.js";
import { ticketCreate } from "./ticket/create.js";
import { ticketDepAdd } from "./ticket/dep-add.js";
import { ticketDepList } from "./ticket/dep-list.js";
import { ticketDepRm } from "./ticket/dep-rm.js";
import { ticketEdit } from "./ticket/edit.js";
import { ticketFollow } from "./ticket/follow.js";
import { ticketHistory } from "./ticket/history.js";
import { ticketInstructions } from "./ticket/instructions.js";
import { ticketList } from "./ticket/list.js";
import { ticketMove } from "./ticket/move.js";
import { ticketOwner } from "./ticket/owner.js";
import { ticketReopen } from "./ticket/reopen.js";
import { ticketReplay } from "./ticket/replay.js";
import { ticketRetry } from "./ticket/retry.js";
import { ticketShow } from "./ticket/show.js";
import { ticketTemplate } from "./ticket/template.js";
import { ticketTypes } from "./ticket/types.js";
import { ticketUnfollow } from "./ticket/unfollow.js";

/**
 * Every implemented command. A command is added here only when the public API route it calls
 * exists; planned commands live in docs/commands.md until then.
 */
export const commands: readonly CommandSpec[] = [
  authLogin,
  authLogout,
  authStatus,
  authList,
  authRevoke,
  accountList,
  accountUse,
  projectList,
  projectShow,
  domainList,
  domainShow,
  domainCreate,
  domainEdit,
  domainArchive,
  domainUnarchive,
  domainProjectAdd,
  domainProjectRm,
  domainParentAdd,
  domainParentRm,
  domainMemberAdd,
  domainMemberRm,
  domainMaintainerAdd,
  domainMaintainerRm,
  domainEpics,
  contractList,
  contractShow,
  contractCreate,
  contractPublish,
  contractPropose,
  contractRevise,
  contractAccept,
  ticketList,
  ticketShow,
  ticketCreate,
  ticketEdit,
  ticketOwner,
  ticketFollow,
  ticketUnfollow,
  ticketTemplate,
  ticketTypes,
  ticketDepAdd,
  ticketDepRm,
  ticketDepList,
  ticketContractImplements,
  ticketContractBuildsAgainst,
  ticketContractRm,
  ticketMove,
  ticketActions,
  ticketAct,
  ticketRetry,
  ticketReplay,
  ticketReopen,
  ticketCancel,
  ticketClarify,
  ticketInstructions,
  ticketHistory,
  intentSubmit,
  intentRespond,
  intentList,
  intentShow,
  intentWithdraw,
  requestSubmit,
  requestList,
  requestShow,
  requestReply,
  requestAcknowledge,
  requestAccept,
  requestClose,
  requestPromote,
  epicList,
  epicShow,
  epicCreate,
  epicEdit,
  epicDagShow,
  epicEdgeAdd,
  epicEdgeRm,
  workerEnroll,
  workerInstall,
  workerUpdate,
  workerUninstall,
  workerVerify,
  workerStart,
  workerStop,
  workerStatus,
  workerDoctor,
  workerSubscriptions,
  workerSubscriptionsUse,
  planShow,
  planApply,
  planPromote,
  planTemplate,
  planCohorts,
  manifestTemplate,
  manifestApply,
  runList,
  runShow,
  runNodeOutput,
  reviewList,
  reviewAttention,
  sessionSteer,
  sessionInstructions,
  sessionEditInstruction,
  sessionWithdrawInstruction,
  skillsInstall,
  skillsStatusCommand,
  feedbackSend,
  setup,
  doctor,
  ...apiCommands(),
];
