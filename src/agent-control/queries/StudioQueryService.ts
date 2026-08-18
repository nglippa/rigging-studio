import type { GeneratedCharacterProject } from "../../character-generation/project/generatedCharacterProject";
import type { RigDefinition } from "../../rigging/schema/types";
import { validateRigDefinition } from "../../rigging/validation/rig";
import type { AnimationLibrary } from "../../tools/rig-editor/animation/types";
import type { StudioSessionState } from "../session/StudioSession";
import { animationListSummary, animationSummary, projectSummary, rigSummary } from "./summaries";

export type StudioReadModel = {
  readonly session: StudioSessionState;
  readonly project: GeneratedCharacterProject | null;
  readonly rig: RigDefinition | null;
  readonly animations: AnimationLibrary | null;
  readonly activeSkinId: string | null;
  readonly liveUi: boolean;
  readonly previewAvailable: boolean;
};

type ReadModelProvider = () => StudioReadModel;

export class StudioQueryService {
  constructor(private readonly read: ReadModelProvider) {}

  getStudioStatus(includeActivity = false) {
    const { session, liveUi, previewAvailable } = this.read();
    return {
      connected: session.mcpConnected && session.toolCount > 0, bridgeConnected: session.bridgeConnected,
      mcpConnected: session.mcpConnected, toolCount: session.toolCount, sessionId: session.sessionId, activeProjectId: session.activeProjectId,
      activeStage: session.activeStage, selectedRigId: session.selectedRigId, selectedAnimationId: session.selectedAnimationId,
      selectedBoneId: session.selectedBoneId, dirty: session.dirtyState, validation: session.validationState,
      lastRenderId: session.lastRenderId, lastOperation: session.lastOperation, warnings: session.warnings,
      ...(includeActivity ? { activity: session.activity } : {}),
      capabilities: { liveUi, transactions: true, previews: previewAvailable },
    };
  }

  getAgentCapabilities(includeToolNames = false) {
    const { session } = this.read();
    return {
      bridgeConnected: session.bridgeConnected,
      mcpConnected: session.mcpConnected,
      toolCount: session.toolCount,
      ...(includeToolNames ? { toolNames: session.toolNames } : { toolSummary: session.toolNames.slice(0, 8) }),
      resourcesAvailable: session.resourcesAvailable,
      lastHandshake: session.lastHandshake,
      lastError: session.lastAgentError,
      ready: session.mcpConnected && session.toolCount > 0,
    };
  }

  getActiveProject(includeFull = false) {
    const { project } = this.read();
    return project ? (includeFull ? structuredClone(project) : projectSummary(project)) : null;
  }

  getCurrentStage(): string | null { return this.read().session.activeStage; }

  getRigSummary(includeHierarchy = true, includeFull = false) {
    const { rig } = this.read();
    return rig ? (includeFull ? structuredClone(rig) : rigSummary(rig, includeHierarchy)) : null;
  }

  getBoneHierarchy() {
    return this.read().rig?.bones.map((bone) => ({
      id: bone.id, parentId: bone.parentId, x: bone.x, y: bone.y, rotation: bone.rotation,
      scaleX: bone.scaleX, scaleY: bone.scaleY, length: bone.length,
    })) ?? [];
  }

  getSlotSummary() {
    return this.read().rig?.slots.map((slot) => ({
      id: slot.id, boneId: slot.boneId, attachmentId: slot.attachmentId, zIndex: slot.zIndex, visible: slot.visible,
    })) ?? [];
  }

  getAnimationList() {
    const { animations } = this.read();
    return animations ? animationListSummary(animations) : [];
  }

  getAnimationSummary(animationId: string, includeTracks = true, includeFull = false) {
    const animation = this.read().animations?.animations.find((candidate) => candidate.id === animationId);
    return animation ? (includeFull ? structuredClone(animation) : animationSummary(animation, includeTracks)) : null;
  }

  getCurrentWarnings(): readonly string[] {
    const model = this.read();
    return [...new Set([...(model.project?.warnings ?? []), ...model.session.warnings])];
  }

  getValidationErrors() {
    const { rig } = this.read();
    return rig ? validateRigDefinition(rig) : [];
  }

  getEquipmentState() {
    const { rig, activeSkinId } = this.read();
    if (!rig) return { skinId: null, slots: [] };
    const skin = rig.skins.find((candidate) => candidate.id === (activeSkinId ?? rig.defaultSkinId));
    return {
      skinId: skin?.id ?? rig.defaultSkinId,
      slots: rig.slots.map((slot) => ({ slotId: slot.id, attachmentId: skin?.slotAttachments[slot.id] ?? slot.attachmentId })),
    };
  }

  getGenerationHistory() {
    const { project } = this.read();
    if (!project) return { currentGeneration: null, userCorrections: [] };
    return {
      currentGeneration: project.sourceImage ? {
        generationId: project.sourceImage.generationId, width: project.sourceImage.width,
        height: project.sourceImage.height, warnings: project.sourceImage.warnings,
        generationMode: project.sourceImage.generationMode, novelArtwork: project.sourceImage.novelArtwork,
        provider: project.sourceImage.provider, sourceArtifact: project.sourceImage.sourceArtifact,
      } : null,
      generations: project.generationHistory.map((generation) => ({
        generationId: generation.generationId, generationMode: generation.generationMode, novelArtwork: generation.novelArtwork,
        provider: generation.provider, sourceArtifact: generation.sourceArtifact, width: generation.width, height: generation.height,
      })),
      userCorrections: project.userCorrections,
    };
  }

  getCharacterParts(includeFull = false) {
    const { project } = this.read();
    if (!project) return [];
    if (includeFull) return structuredClone(project.segmentationData?.parts ?? []);
    const extractedIds = new Set(project.extractedParts.map((part) => part.partId));
    return project.segmentationData?.parts.map((part) => ({ id: part.id, semanticType: part.semanticType, accepted: part.accepted, extracted: extractedIds.has(part.id) })) ?? [];
  }

  getSelectedObject() {
    const { session } = this.read();
    if (session.selectedBoneId) return { type: "bone" as const, id: session.selectedBoneId };
    if (session.selectedAnimationId) return { type: "animation" as const, id: session.selectedAnimationId };
    if (session.selectedRigId) return { type: "rig" as const, id: session.selectedRigId };
    return null;
  }

  getProjectMetadata() {
    const { project } = this.read();
    return project ? {
      id: project.id, name: project.name, version: project.projectVersion, stage: project.stage,
      createdAt: project.createdAt, updatedAt: project.updatedAt, generationMetadata: project.generationMetadata,
    } : null;
  }
}
