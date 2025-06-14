import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { createLogger } from '@/lib/logs/console-logger'
import { clearWorkflowVariablesTracking } from '@/stores/panel/variables/store'
import { API_ENDPOINTS, STORAGE_KEYS } from '../../constants'
import {
  loadWorkflowState,
  removeFromStorage,
  saveRegistry,
  saveSubblockValues,
  saveWorkflowState,
} from '../persistence'
import { useSubBlockStore } from '../subblock/store'
import { fetchWorkflowsFromDB, resetRegistryInitialization, workflowSync } from '../sync'
import { useWorkflowStore } from '../workflow/store'
import type { DeploymentStatus, WorkflowMetadata, WorkflowRegistry } from './types'
import { generateUniqueName, getNextWorkflowColor } from './utils'

const logger = createLogger('WorkflowRegistry')

// Storage key for active workspace
const ACTIVE_WORKSPACE_KEY = 'active-workspace-id'

// Track workspace transitions to prevent race conditions
let isWorkspaceTransitioning = false
const TRANSITION_TIMEOUT = 5000 // 5 seconds maximum for workspace transitions

// Helps clean up any localStorage data that isn't needed for the current workspace
function cleanupLocalStorageForWorkspace(workspaceId: string): void {
  if (typeof window === 'undefined') return

  try {
    const { workflows } = useWorkflowRegistry.getState()
    const workflowIds = Object.keys(workflows)

    // Find all localStorage keys that start with workflow- or subblock-values-
    const localStorageKeys = Object.keys(localStorage)
    const workflowKeys = localStorageKeys.filter(
      (key) => key.startsWith('workflow-') || key.startsWith('subblock-values-')
    )

    // Extract the workflow ID from each key (remove the prefix)
    for (const key of workflowKeys) {
      let workflowId: string | null = null

      if (key.startsWith('workflow-')) {
        workflowId = key.replace('workflow-', '')
      } else if (key.startsWith('subblock-values-')) {
        workflowId = key.replace('subblock-values-', '')
      }

      if (workflowId) {
        // Case 1: Clean up workflows not in the registry
        if (!workflowIds.includes(workflowId)) {
          // Check if this workflow exists in a different workspace
          // We don't want to remove data for workflows in other workspaces
          const exists = localStorage.getItem(`workflow-${workflowId}`)
          if (exists) {
            try {
              const parsed = JSON.parse(exists)
              // If we can't determine the workspace, leave it alone for safety
              if (!parsed || !parsed.workspaceId) continue

              // Only remove if it belongs to the current workspace
              if (parsed.workspaceId === workspaceId) {
                localStorage.removeItem(key)
              }
            } catch (_e) {}
          } else {
            // If we can't determine the workspace, remove it to be safe
            localStorage.removeItem(key)
          }
        }
        // Case 2: Clean up workflows that reference deleted workspaces
        else {
          const exists = localStorage.getItem(`workflow-${workflowId}`)
          if (exists) {
            try {
              const parsed = JSON.parse(exists)
              if (parsed?.workspaceId && parsed.workspaceId !== workspaceId) {
                // Check if this workspace still exists in our list
                const workspacesData = localStorage.getItem('workspaces')
                if (workspacesData) {
                  try {
                    const workspaces = JSON.parse(workspacesData)
                    const workspaceExists = workspaces.some((w: any) => w.id === parsed.workspaceId)

                    if (!workspaceExists) {
                      // Workspace doesn't exist, update the workflow to use current workspace
                      parsed.workspaceId = workspaceId
                      localStorage.setItem(`workflow-${workflowId}`, JSON.stringify(parsed))
                    }
                  } catch (_e) {
                    // Skip if we can't parse workspaces data
                  }
                }
              }
            } catch (_e) {
              // Skip if we can't parse the data
            }
          }
        }
      }
    }
  } catch (error) {
    logger.error('Error cleaning up localStorage:', error)
  }
}

// Resets workflow and subblock stores to prevent data leakage between workspaces
function resetWorkflowStores() {
  // Reset variable tracking to prevent stale API calls
  clearWorkflowVariablesTracking()

  // Reset the workflow store to prevent data leakage between workspaces
  useWorkflowStore.setState({
    blocks: {},
    edges: [],
    loops: {},
    isDeployed: false,
    deployedAt: undefined,
    deploymentStatuses: {}, // Reset deployment statuses map
    hasActiveSchedule: false,
    history: {
      past: [],
      present: {
        state: {
          blocks: {},
          edges: [],
          loops: {},
          parallels: {},
          isDeployed: false,
          deployedAt: undefined,
        },
        timestamp: Date.now(),
        action: 'Initial state',
        subblockValues: {},
      },
      future: [],
    },
    lastSaved: Date.now(),
  })

  // Reset the subblock store
  useSubBlockStore.setState({
    workflowValues: {},
    toolParams: {},
  })
}

/**
 * Handles workspace transition state tracking
 * @param isTransitioning Whether workspace is currently transitioning
 */
function setWorkspaceTransitioning(isTransitioning: boolean): void {
  isWorkspaceTransitioning = isTransitioning

  // Set a safety timeout to prevent permanently stuck in transition state
  if (isTransitioning) {
    setTimeout(() => {
      if (isWorkspaceTransitioning) {
        logger.warn('Forcing workspace transition to complete due to timeout')
        isWorkspaceTransitioning = false
      }
    }, TRANSITION_TIMEOUT)
  }
}

/**
 * Checks if workspace is currently in transition
 * @returns True if workspace is transitioning
 */
export function isWorkspaceInTransition(): boolean {
  return isWorkspaceTransitioning
}

export const useWorkflowRegistry = create<WorkflowRegistry>()(
  devtools(
    (set, get) => ({
      // Store state
      workflows: {},
      activeWorkflowId: null,
      activeWorkspaceId:
        typeof window !== 'undefined' ? localStorage.getItem(ACTIVE_WORKSPACE_KEY) : null,
      isLoading: false,
      error: null,
      // Initialize deployment statuses
      deploymentStatuses: {},

      // Set loading state
      setLoading: (loading: boolean) => {
        // Only set loading to true if workflows is empty
        if (!loading || Object.keys(get().workflows).length === 0) {
          set({ isLoading: loading })
        }
      },

      // Handle cleanup on workspace deletion
      handleWorkspaceDeletion: (newWorkspaceId: string) => {
        const currentWorkspaceId = get().activeWorkspaceId

        if (!newWorkspaceId || newWorkspaceId === currentWorkspaceId) {
          logger.error('Cannot switch to invalid workspace after deletion')
          return
        }

        // Set transition state
        setWorkspaceTransitioning(true)

        logger.info(`Switching from deleted workspace ${currentWorkspaceId} to ${newWorkspaceId}`)

        // Reset all workflow state
        resetWorkflowStores()

        // Reset registry initialization state
        resetRegistryInitialization()

        // Save to localStorage for persistence
        if (typeof window !== 'undefined') {
          localStorage.setItem(ACTIVE_WORKSPACE_KEY, newWorkspaceId)
        }

        // Set loading state while we fetch workflows
        set({
          isLoading: true,
          workflows: {},
          activeWorkspaceId: newWorkspaceId,
          activeWorkflowId: null,
        })

        // Fetch workflows specifically for this workspace
        fetchWorkflowsFromDB()
          .then(() => {
            set({ isLoading: false })

            // Clean up any stale localStorage data
            cleanupLocalStorageForWorkspace(newWorkspaceId)

            // End transition state
            setWorkspaceTransitioning(false)
          })
          .catch((error) => {
            logger.error('Error fetching workflows after workspace deletion:', {
              error,
              workspaceId: newWorkspaceId,
            })
            set({ isLoading: false, error: 'Failed to load workspace data' })

            // End transition state even on error
            setWorkspaceTransitioning(false)
          })
      },

      // Set active workspace and update UI
      setActiveWorkspace: (id: string) => {
        const currentWorkspaceId = get().activeWorkspaceId

        // Only perform the switch if the workspace is different
        if (id === currentWorkspaceId) {
          return
        }

        // Prevent multiple workspace transitions at once
        if (isWorkspaceTransitioning) {
          logger.warn('Workspace already transitioning, ignoring new request')
          return
        }

        // Set transition state
        setWorkspaceTransitioning(true)

        logger.info(`Switching workspace from ${currentWorkspaceId} to ${id}`)

        // Reset all workflow state
        resetWorkflowStores()

        // Reset registry initialization state
        resetRegistryInitialization()

        // Save to localStorage for persistence
        if (typeof window !== 'undefined') {
          localStorage.setItem(ACTIVE_WORKSPACE_KEY, id)
        }

        // Set loading state while we fetch workflows
        set({
          isLoading: true,
          // Clear workflows to prevent showing old data during transition
          workflows: {},
          activeWorkspaceId: id,
          // Reset active workflow when switching workspaces
          activeWorkflowId: null,
        })

        // Fetch workflows specifically for this workspace
        // This is better than just triggering a sync as it's more immediate
        fetchWorkflowsFromDB()
          .then(() => {
            set({ isLoading: false })

            // Clean up any stale localStorage data for this workspace
            cleanupLocalStorageForWorkspace(id)

            // End transition state
            setWorkspaceTransitioning(false)
          })
          .catch((error) => {
            logger.error('Error fetching workflows for workspace:', { error, workspaceId: id })
            set({ isLoading: false, error: 'Failed to load workspace data' })

            // End transition state even on error
            setWorkspaceTransitioning(false)
          })
      },

      // Method to get deployment status for a specific workflow
      getWorkflowDeploymentStatus: (workflowId: string | null): DeploymentStatus | null => {
        if (!workflowId) {
          // If no workflow ID provided, check the active workflow
          workflowId = get().activeWorkflowId
          if (!workflowId) return null
        }

        const { deploymentStatuses = {} } = get()

        // First try to get from the workflow-specific deployment statuses
        if (deploymentStatuses[workflowId]) {
          return deploymentStatuses[workflowId]
        }

        // For backward compatibility, check the workflow state in workflow store
        // This will only be relevant during the transition period
        const workflowState = loadWorkflowState(workflowId)
        if (workflowState) {
          // Check workflow-specific status in the workflow state
          if (workflowState.deploymentStatuses?.[workflowId]) {
            return workflowState.deploymentStatuses[workflowId]
          }

          // Fallback to legacy fields if needed
          if (workflowState.isDeployed) {
            return {
              isDeployed: workflowState.isDeployed || false,
              deployedAt: workflowState.deployedAt,
            }
          }
        }

        // No deployment status found
        return null
      },

      // Method to set deployment status for a specific workflow
      setDeploymentStatus: (
        workflowId: string | null,
        isDeployed: boolean,
        deployedAt?: Date,
        apiKey?: string
      ) => {
        if (!workflowId) {
          workflowId = get().activeWorkflowId
          if (!workflowId) return
        }

        // Update the deployment statuses in the registry
        set((state) => ({
          deploymentStatuses: {
            ...state.deploymentStatuses,
            [workflowId as string]: {
              isDeployed,
              deployedAt: deployedAt || (isDeployed ? new Date() : undefined),
              apiKey,
              // Preserve existing needsRedeployment flag if available, but reset if newly deployed
              needsRedeployment: isDeployed
                ? false
                : ((state.deploymentStatuses?.[workflowId as string] as any)?.needsRedeployment ??
                  false),
            },
          },
        }))

        // Also update the workflow store if this is the active workflow
        const { activeWorkflowId } = get()
        if (workflowId === activeWorkflowId) {
          // Update the workflow store for backward compatibility
          useWorkflowStore.setState((state) => ({
            isDeployed,
            deployedAt: deployedAt || (isDeployed ? new Date() : undefined),
            needsRedeployment: isDeployed ? false : state.needsRedeployment,
            deploymentStatuses: {
              ...state.deploymentStatuses,
              [workflowId as string]: {
                isDeployed,
                deployedAt: deployedAt || (isDeployed ? new Date() : undefined),
                apiKey,
                needsRedeployment: isDeployed
                  ? false
                  : ((state.deploymentStatuses?.[workflowId as string] as any)?.needsRedeployment ??
                    false),
              },
            },
          }))
        }

        // Save the deployment status in the workflow state
        const workflowState = loadWorkflowState(workflowId)
        if (workflowState) {
          saveWorkflowState(workflowId, {
            ...workflowState,
            // Update both legacy and new fields for compatibility
            isDeployed: workflowId === activeWorkflowId ? isDeployed : workflowState.isDeployed,
            deployedAt:
              workflowId === activeWorkflowId
                ? deployedAt || (isDeployed ? new Date() : undefined)
                : workflowState.deployedAt,
            deploymentStatuses: {
              ...(workflowState.deploymentStatuses || {}),
              [workflowId]: {
                isDeployed,
                deployedAt: deployedAt || (isDeployed ? new Date() : undefined),
                apiKey,
                needsRedeployment: isDeployed
                  ? false
                  : ((workflowState.deploymentStatuses?.[workflowId] as any)?.needsRedeployment ??
                    false),
              },
            },
          })
        }

        // Trigger workflow sync to update server state
        workflowSync.sync()
      },

      // Method to set the needsRedeployment flag for a specific workflow
      setWorkflowNeedsRedeployment: (workflowId: string | null, needsRedeployment: boolean) => {
        if (!workflowId) {
          workflowId = get().activeWorkflowId
          if (!workflowId) return
        }

        // Update the registry's deployment status for this specific workflow
        set((state) => {
          const deploymentStatuses = state.deploymentStatuses || {}
          const currentStatus = deploymentStatuses[workflowId as string] || { isDeployed: false }

          return {
            deploymentStatuses: {
              ...deploymentStatuses,
              [workflowId as string]: {
                ...currentStatus,
                needsRedeployment,
              },
            },
          }
        })

        // Only update the global flag if this is the active workflow
        const { activeWorkflowId } = get()
        if (workflowId === activeWorkflowId) {
          useWorkflowStore.getState().setNeedsRedeploymentFlag(needsRedeployment)
        }
        // Save to persistent storage
        const workflowState = loadWorkflowState(workflowId)
        if (workflowState) {
          const deploymentStatuses = workflowState.deploymentStatuses || {}
          const currentStatus = deploymentStatuses[workflowId] || { isDeployed: false }

          saveWorkflowState(workflowId, {
            ...workflowState,
            deploymentStatuses: {
              ...deploymentStatuses,
              [workflowId]: {
                ...currentStatus,
                needsRedeployment,
              },
            },
          })
        }
      },

      // Modified setActiveWorkflow to load deployment statuses
      setActiveWorkflow: async (id: string) => {
        const { workflows } = get()
        if (!workflows[id]) {
          set({ error: `Workflow ${id} not found` })
          return
        }

        // Get current workflow ID
        const currentId = get().activeWorkflowId
        // Save current workflow state before switching
        if (currentId) {
          const currentState = useWorkflowStore.getState()

          // Generate loops and parallels from current blocks
          const generatedLoops = currentState.generateLoopBlocks
            ? currentState.generateLoopBlocks()
            : {}
          const generatedParallels = currentState.generateParallelBlocks
            ? currentState.generateParallelBlocks()
            : {}

          // Save the complete state for the current workflow
          saveWorkflowState(currentId, {
            blocks: currentState.blocks,
            edges: currentState.edges,
            loops: generatedLoops,
            parallels: generatedParallels,
            history: currentState.history,
            isDeployed: currentState.isDeployed,
            deployedAt: currentState.deployedAt,
            deploymentStatuses: currentState.deploymentStatuses,
            lastSaved: Date.now(),
          })

          // Also save current subblock values
          const currentSubblockValues = useSubBlockStore.getState().workflowValues[currentId]
          if (currentSubblockValues) {
            saveSubblockValues(currentId, currentSubblockValues)
          }
        }

        // Load workflow state for the new active workflow
        const parsedState = loadWorkflowState(id)
        if (parsedState) {
          const {
            blocks,
            edges,
            parallels,
            history,
            loops,
            isDeployed,
            deployedAt,
            deploymentStatuses,
            needsRedeployment,
          } = parsedState

          // Get workflow-specific deployment status
          let workflowIsDeployed = isDeployed
          let workflowDeployedAt = deployedAt
          let workflowNeedsRedeployment = needsRedeployment

          // Check if we have a workflow-specific deployment status
          if (deploymentStatuses?.[id]) {
            workflowIsDeployed = deploymentStatuses[id].isDeployed
            workflowDeployedAt = deploymentStatuses[id].deployedAt
            workflowNeedsRedeployment = deploymentStatuses[id].needsRedeployment
          }

          // Initialize subblock store with workflow values
          useSubBlockStore.getState().initializeFromWorkflow(id, blocks)

          // Set the workflow store state with the loaded state
          useWorkflowStore.setState({
            blocks,
            edges,
            loops,
            parallels,
            isDeployed: workflowIsDeployed !== undefined ? workflowIsDeployed : false,
            deployedAt: workflowDeployedAt ? new Date(workflowDeployedAt) : undefined,
            needsRedeployment:
              workflowNeedsRedeployment !== undefined ? workflowNeedsRedeployment : false,
            deploymentStatuses: deploymentStatuses || {},
            hasActiveSchedule: false,
            history: history || {
              past: [],
              present: {
                state: {
                  blocks,
                  edges,
                  loops,
                  parallels,
                  isDeployed: workflowIsDeployed !== undefined ? workflowIsDeployed : false,
                  deployedAt: workflowDeployedAt,
                },
                timestamp: Date.now(),
                action: 'Initial state',
                subblockValues: {},
              },
              future: [],
            },
            lastSaved: parsedState.lastSaved || Date.now(),
          })

          // Update the deployment statuses in the registry
          if (deploymentStatuses) {
            set((state) => ({
              deploymentStatuses: {
                ...state.deploymentStatuses,
                ...deploymentStatuses,
              },
            }))
          } else if (workflowIsDeployed !== undefined) {
            // If there's no deployment statuses object but we have legacy deployment status,
            // create an entry in the deploymentStatuses map
            set((state) => ({
              deploymentStatuses: {
                ...state.deploymentStatuses,
                [id]: {
                  isDeployed: workflowIsDeployed as boolean,
                  deployedAt: workflowDeployedAt ? new Date(workflowDeployedAt) : undefined,
                },
              },
            }))
          }

          logger.info(`Switched to workflow ${id}`)
        } else {
          // If no saved state, initialize with empty state
          useWorkflowStore.setState({
            blocks: {},
            edges: [],
            loops: {},
            parallels: {},
            isDeployed: false,
            deployedAt: undefined,
            deploymentStatuses: {},
            hasActiveSchedule: false,
            history: {
              past: [],
              present: {
                state: {
                  blocks: {},
                  edges: [],
                  loops: {},
                  parallels: {},
                  isDeployed: false,
                  deployedAt: undefined,
                },
                timestamp: Date.now(),
                action: 'Initial state',
                subblockValues: {},
              },
              future: [],
            },
            lastSaved: Date.now(),
          })

          logger.warn(`No saved state found for workflow ${id}, initialized with empty state`)
        }

        // Update the active workflow ID
        set({ activeWorkflowId: id, error: null })
      },

      /**
       * Creates a new workflow with appropriate metadata and initial blocks
       * @param options - Optional configuration for workflow creation
       * @returns The ID of the newly created workflow
       */
      createWorkflow: (options = {}) => {
        const { workflows, activeWorkspaceId } = get()
        const id = crypto.randomUUID()

        // Use provided workspace ID or fall back to active workspace ID
        const workspaceId = options.workspaceId || activeWorkspaceId || undefined

        logger.info(`Creating new workflow in workspace: ${workspaceId || 'none'}`)

        // Generate workflow metadata with appropriate name and color
        const newWorkflow: WorkflowMetadata = {
          id,
          name: options.name || generateUniqueName(workflows),
          lastModified: new Date(),
          description: options.description || 'New workflow',
          color: options.marketplaceId ? '#808080' : getNextWorkflowColor(workflows), // Gray for marketplace imports
          marketplaceData: options.marketplaceId
            ? { id: options.marketplaceId, status: 'temp' as const }
            : undefined,
          workspaceId, // Associate with workspace
          folderId: options.folderId || null, // Associate with folder if provided
        }

        let initialState: any

        // If this is a marketplace import with existing state
        if (options.marketplaceId && options.marketplaceState) {
          initialState = {
            blocks: options.marketplaceState.blocks || {},
            edges: options.marketplaceState.edges || [],
            loops: options.marketplaceState.loops || {},
            parallels: options.marketplaceState.parallels || {},
            isDeployed: false,
            deployedAt: undefined,
            deploymentStatuses: {}, // Initialize empty deployment statuses map
            workspaceId, // Include workspace ID in the state object
            history: {
              past: [],
              present: {
                state: {
                  blocks: options.marketplaceState.blocks || {},
                  edges: options.marketplaceState.edges || [],
                  loops: options.marketplaceState.loops || {},
                  parallels: options.marketplaceState.parallels || {},
                  isDeployed: false,
                  deployedAt: undefined,
                  workspaceId, // Include workspace ID in history
                },
                timestamp: Date.now(),
                action: 'Imported from marketplace',
                subblockValues: {},
              },
              future: [],
            },
            lastSaved: Date.now(),
          }

          logger.info(`Created workflow from marketplace: ${options.marketplaceId}`)
        } else {
          // Create starter block for new workflow
          const starterId = crypto.randomUUID()
          const starterBlock = {
            id: starterId,
            type: 'starter' as const,
            name: 'Start',
            position: { x: 100, y: 100 },
            subBlocks: {
              startWorkflow: {
                id: 'startWorkflow',
                type: 'dropdown' as const,
                value: 'manual',
              },
              webhookPath: {
                id: 'webhookPath',
                type: 'short-input' as const,
                value: '',
              },
              webhookSecret: {
                id: 'webhookSecret',
                type: 'short-input' as const,
                value: '',
              },
              scheduleType: {
                id: 'scheduleType',
                type: 'dropdown' as const,
                value: 'daily',
              },
              minutesInterval: {
                id: 'minutesInterval',
                type: 'short-input' as const,
                value: '',
              },
              minutesStartingAt: {
                id: 'minutesStartingAt',
                type: 'short-input' as const,
                value: '',
              },
              hourlyMinute: {
                id: 'hourlyMinute',
                type: 'short-input' as const,
                value: '',
              },
              dailyTime: {
                id: 'dailyTime',
                type: 'short-input' as const,
                value: '',
              },
              weeklyDay: {
                id: 'weeklyDay',
                type: 'dropdown' as const,
                value: 'MON',
              },
              weeklyDayTime: {
                id: 'weeklyDayTime',
                type: 'short-input' as const,
                value: '',
              },
              monthlyDay: {
                id: 'monthlyDay',
                type: 'short-input' as const,
                value: '',
              },
              monthlyTime: {
                id: 'monthlyTime',
                type: 'short-input' as const,
                value: '',
              },
              cronExpression: {
                id: 'cronExpression',
                type: 'short-input' as const,
                value: '',
              },
              timezone: {
                id: 'timezone',
                type: 'dropdown' as const,
                value: 'UTC',
              },
            },
            outputs: {
              response: {
                type: {
                  input: 'any',
                },
              },
            },
            enabled: true,
            horizontalHandles: true,
            isWide: false,
            height: 0,
          }

          initialState = {
            blocks: {
              [starterId]: starterBlock,
            },
            edges: [],
            loops: {},
            parallels: {},
            isDeployed: false,
            deployedAt: undefined,
            deploymentStatuses: {}, // Initialize empty deployment statuses map
            workspaceId, // Include workspace ID in the state object
            history: {
              past: [],
              present: {
                state: {
                  blocks: {
                    [starterId]: starterBlock,
                  },
                  edges: [],
                  loops: {},
                  parallels: {},
                  isDeployed: false,
                  deployedAt: undefined,
                  workspaceId, // Include workspace ID in history
                },
                timestamp: Date.now(),
                action: 'Initial state',
                subblockValues: {},
              },
              future: [],
            },
            lastSaved: Date.now(),
          }
        }

        // Add workflow to registry
        set((state) => ({
          workflows: {
            ...state.workflows,
            [id]: newWorkflow,
          },
          error: null,
        }))

        // Save workflow list to localStorage
        const updatedWorkflows = get().workflows
        saveRegistry(updatedWorkflows)

        // Save initial workflow state to localStorage
        saveWorkflowState(id, initialState)

        // Initialize subblock values if this is a marketplace import
        if (options.marketplaceId && options.marketplaceState?.blocks) {
          useSubBlockStore.getState().initializeFromWorkflow(id, options.marketplaceState.blocks)
        }

        // If this is the first workflow or it's an initial workflow, set it as active
        if (options.isInitial || Object.keys(updatedWorkflows).length === 1) {
          set({ activeWorkflowId: id })
          useWorkflowStore.setState(initialState)
        } else {
          // Make sure we switch to this workflow
          set({ activeWorkflowId: id })
          useWorkflowStore.setState(initialState)
        }

        // Mark as dirty to ensure sync
        useWorkflowStore.getState().sync.markDirty()

        // Trigger sync
        useWorkflowStore.getState().sync.forceSync()

        logger.info(`Created new workflow with ID ${id} in workspace ${workspaceId || 'none'}`)

        return id
      },

      /**
       * Creates a new workflow from a marketplace workflow
       * @param marketplaceId - The ID of the marketplace workflow to import
       * @param state - The state of the marketplace workflow (blocks, edges, loops)
       * @param metadata - Additional metadata like name, description from marketplace
       * @returns The ID of the newly created workflow
       */
      createMarketplaceWorkflow: (
        marketplaceId: string,
        state: any,
        metadata: Partial<WorkflowMetadata>
      ) => {
        const { workflows } = get()
        const id = crypto.randomUUID()

        // Generate workflow metadata with marketplace properties
        const newWorkflow: WorkflowMetadata = {
          id,
          name: metadata.name || 'Marketplace workflow',
          lastModified: new Date(),
          description: metadata.description || 'Imported from marketplace',
          color: metadata.color || getNextWorkflowColor(workflows),
          marketplaceData: { id: marketplaceId, status: 'temp' as const },
        }

        // Prepare workflow state based on the marketplace workflow state
        const initialState = {
          blocks: state.blocks || {},
          edges: state.edges || [],
          loops: state.loops || {},
          parallels: state.parallels || {},
          isDeployed: false,
          deployedAt: undefined,
          history: {
            past: [],
            present: {
              state: {
                blocks: state.blocks || {},
                edges: state.edges || [],
                loops: state.loops || {},
                parallels: state.parallels || {},
                isDeployed: false,
                deployedAt: undefined,
              },
              timestamp: Date.now(),
              action: 'Imported from marketplace',
              subblockValues: {},
            },
            future: [],
          },
          lastSaved: Date.now(),
        }

        // Add workflow to registry
        set((state) => ({
          workflows: {
            ...state.workflows,
            [id]: newWorkflow,
          },
          error: null,
        }))

        // Save workflow list to localStorage
        const updatedWorkflows = get().workflows
        saveRegistry(updatedWorkflows)

        // Save workflow state to localStorage
        saveWorkflowState(id, initialState)

        // Initialize subblock values from state blocks
        if (state.blocks) {
          useSubBlockStore.getState().initializeFromWorkflow(id, state.blocks)
        }

        // Mark as dirty to ensure sync
        useWorkflowStore.getState().sync.markDirty()

        // Trigger sync
        useWorkflowStore.getState().sync.forceSync()

        logger.info(`Created marketplace workflow ${id} imported from ${marketplaceId}`)

        return id
      },

      /**
       * Duplicates an existing workflow
       * @param sourceId - The ID of the workflow to duplicate
       * @returns The ID of the newly created workflow
       */
      duplicateWorkflow: (sourceId: string) => {
        const { workflows, activeWorkspaceId } = get()
        const sourceWorkflow = workflows[sourceId]

        if (!sourceWorkflow) {
          set({ error: `Workflow ${sourceId} not found` })
          return null
        }

        const id = crypto.randomUUID()

        // Load the source workflow state
        const sourceState = loadWorkflowState(sourceId)
        if (!sourceState) {
          set({ error: `No state found for workflow ${sourceId}` })
          return null
        }

        // Get the workspace ID from the source workflow or fall back to active workspace
        const workspaceId = sourceWorkflow.workspaceId || activeWorkspaceId || undefined

        // Generate new workflow metadata
        const newWorkflow: WorkflowMetadata = {
          id,
          name: `${sourceWorkflow.name} (Copy)`,
          lastModified: new Date(),
          description: sourceWorkflow.description,
          color: getNextWorkflowColor(workflows),
          workspaceId, // Include the workspaceId in the new workflow
          // Do not copy marketplace data
        }

        // Create new workflow state without deployment data
        const newState = {
          blocks: sourceState.blocks || {},
          edges: sourceState.edges || [],
          loops: sourceState.loops || {},
          parallels: sourceState.parallels || {},
          isDeployed: false, // Reset deployment status
          deployedAt: undefined, // Reset deployment timestamp
          workspaceId, // Include workspaceId in state
          deploymentStatuses: {}, // Start with empty deployment statuses map
          history: {
            past: [],
            present: {
              state: {
                blocks: sourceState.blocks || {},
                edges: sourceState.edges || [],
                loops: sourceState.loops || {},
                parallels: sourceState.parallels || {},
                isDeployed: false,
                deployedAt: undefined,
                workspaceId, // Include workspaceId in history state
              },
              timestamp: Date.now(),
              action: 'Duplicated workflow',
              subblockValues: {},
            },
            future: [],
          },
          lastSaved: Date.now(),
        }

        // Add workflow to registry
        set((state) => ({
          workflows: {
            ...state.workflows,
            [id]: newWorkflow,
          },
          error: null,
        }))

        // Save workflow list to localStorage
        const updatedWorkflows = get().workflows
        saveRegistry(updatedWorkflows)

        // Save workflow state to localStorage
        saveWorkflowState(id, newState)

        // Copy subblock values from the source workflow
        const sourceSubblockValues = useSubBlockStore.getState().workflowValues[sourceId]
        if (sourceSubblockValues) {
          useSubBlockStore.setState((state) => ({
            workflowValues: {
              ...state.workflowValues,
              [id]: JSON.parse(JSON.stringify(sourceSubblockValues)), // Deep copy
            },
          }))

          // Save the copied subblock values
          saveSubblockValues(id, JSON.parse(JSON.stringify(sourceSubblockValues)))
        }

        // Mark as dirty to ensure sync
        useWorkflowStore.getState().sync.markDirty()

        // Trigger sync
        useWorkflowStore.getState().sync.forceSync()

        logger.info(
          `Duplicated workflow ${sourceId} to ${id} in workspace ${workspaceId || 'none'}`
        )

        return id
      },

      // Delete workflow and clean up associated storage
      removeWorkflow: (id: string) => {
        set((state) => {
          const newWorkflows = { ...state.workflows }
          delete newWorkflows[id]

          // Clean up localStorage
          removeFromStorage(STORAGE_KEYS.WORKFLOW(id))
          removeFromStorage(STORAGE_KEYS.SUBBLOCK(id))
          saveRegistry(newWorkflows)

          // Ensure any schedule for this workflow is cancelled
          // The API will handle the deletion of the schedule
          fetch(API_ENDPOINTS.SCHEDULE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              workflowId: id,
              state: { blocks: {} }, // Empty blocks will signal to cancel the schedule
            }),
          }).catch((error) => {
            logger.error(`Error cancelling schedule for deleted workflow ${id}:`, { error })
          })

          // Mark as dirty to ensure sync
          useWorkflowStore.getState().sync.markDirty()

          // Sync deletion with database
          useWorkflowStore.getState().sync.forceSync()

          // If deleting active workflow, switch to another one
          let newActiveWorkflowId = state.activeWorkflowId
          if (state.activeWorkflowId === id) {
            const remainingIds = Object.keys(newWorkflows)
            // Switch to first available workflow
            newActiveWorkflowId = remainingIds[0]
            const savedState = loadWorkflowState(newActiveWorkflowId)
            if (savedState) {
              const { blocks, edges, history, loops, parallels, isDeployed, deployedAt } =
                savedState
              useWorkflowStore.setState({
                blocks,
                edges,
                loops,
                parallels,
                isDeployed: isDeployed || false,
                deployedAt: deployedAt ? new Date(deployedAt) : undefined,
                hasActiveSchedule: false,
                history: history || {
                  past: [],
                  present: {
                    state: {
                      blocks,
                      edges,
                      loops,
                      parallels,
                      isDeployed: isDeployed || false,
                      deployedAt,
                    },
                    timestamp: Date.now(),
                    action: 'Initial state',
                    subblockValues: {},
                  },
                  future: [],
                },
              })
            } else {
              useWorkflowStore.setState({
                blocks: {},
                edges: [],
                loops: {},
                parallels: {},
                isDeployed: false,
                deployedAt: undefined,
                hasActiveSchedule: false,
                history: {
                  past: [],
                  present: {
                    state: {
                      blocks: {},
                      edges: [],
                      loops: {},
                      parallels: {},
                      isDeployed: false,
                      deployedAt: undefined,
                    },
                    timestamp: Date.now(),
                    action: 'Initial state',
                    subblockValues: {},
                  },
                  future: [],
                },
                lastSaved: Date.now(),
              })
            }
          }

          return {
            workflows: newWorkflows,
            activeWorkflowId: newActiveWorkflowId,
            error: null,
          }
        })
      },

      // Update workflow metadata
      updateWorkflow: (id: string, metadata: Partial<WorkflowMetadata>) => {
        set((state) => {
          const workflow = state.workflows[id]
          if (!workflow) return state

          const updatedWorkflows = {
            ...state.workflows,
            [id]: {
              ...workflow,
              ...metadata,
              lastModified: new Date(),
            },
          }

          // Update localStorage
          saveRegistry(updatedWorkflows)

          // Mark as dirty to ensure sync
          useWorkflowStore.getState().sync.markDirty()

          // Use PUT for workflow updates
          useWorkflowStore.getState().sync.forceSync()

          return {
            workflows: updatedWorkflows,
            error: null,
          }
        })
      },
    }),
    { name: 'workflow-registry' }
  )
)
