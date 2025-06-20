import { and, eq, isNull } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/auth'
import { createLogger } from '@/lib/logs/console-logger'
import { saveWorkflowToNormalizedTables } from '@/lib/workflows/db-helpers'
import { db } from '@/db'
import { workflow, workspace, workspaceMember } from '@/db/schema'

const logger = createLogger('WorkflowAPI')

// Define marketplace data schema
const MarketplaceDataSchema = z
  .object({
    id: z.string(),
    status: z.enum(['owner', 'temp']),
  })
  .nullable()
  .optional()

// Schema for workflow data
const WorkflowStateSchema = z.object({
  blocks: z.record(z.any()),
  edges: z.array(z.any()),
  loops: z.record(z.any()).default({}),
  parallels: z.record(z.any()).default({}),
  lastSaved: z.number().optional(),
  isDeployed: z.boolean().optional(),
  deployedAt: z
    .union([z.string(), z.date()])
    .optional()
    .transform((val) => (typeof val === 'string' ? new Date(val) : val)),
  isPublished: z.boolean().optional(),
  marketplaceData: MarketplaceDataSchema,
})

const WorkflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  color: z.string().optional(),
  state: WorkflowStateSchema,
  marketplaceData: MarketplaceDataSchema,
  workspaceId: z.string().optional(),
  folderId: z.string().nullable().optional(),
})

const SyncPayloadSchema = z.object({
  workflows: z.record(z.string(), WorkflowSchema),
  workspaceId: z.string().optional(),
})

// Cache for workspace membership to reduce DB queries
const workspaceMembershipCache = new Map<string, { role: string; expires: number }>()
const CACHE_TTL = 60000 // 1 minute cache expiration
const MAX_CACHE_SIZE = 1000 // Maximum number of entries to prevent unbounded growth

/**
 * Cleans up expired entries from the workspace membership cache
 */
function cleanupExpiredCacheEntries(): void {
  const now = Date.now()
  let expiredCount = 0

  // Remove expired entries
  for (const [key, value] of workspaceMembershipCache.entries()) {
    if (value.expires <= now) {
      workspaceMembershipCache.delete(key)
      expiredCount++
    }
  }

  // If we're still over the limit after removing expired entries,
  // remove the oldest entries (those that will expire soonest)
  if (workspaceMembershipCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(workspaceMembershipCache.entries()).sort(
      (a, b) => a[1].expires - b[1].expires
    )

    const toRemove = entries.slice(0, workspaceMembershipCache.size - MAX_CACHE_SIZE)
    toRemove.forEach(([key]) => workspaceMembershipCache.delete(key))

    logger.debug(
      `Cache cleanup: removed ${expiredCount} expired entries and ${toRemove.length} additional entries due to size limit`
    )
  } else if (expiredCount > 0) {
    logger.debug(`Cache cleanup: removed ${expiredCount} expired entries`)
  }
}

/**
 * Efficiently verifies user's membership and role in a workspace with caching
 * @param userId User ID to check
 * @param workspaceId Workspace ID to check
 * @returns Role if user is a member, null otherwise
 */
async function verifyWorkspaceMembership(
  userId: string,
  workspaceId: string
): Promise<string | null> {
  // Opportunistic cleanup of expired cache entries
  if (workspaceMembershipCache.size > MAX_CACHE_SIZE / 2) {
    cleanupExpiredCacheEntries()
  }

  // Create cache key from userId and workspaceId
  const cacheKey = `${userId}:${workspaceId}`

  // Check cache first
  const cached = workspaceMembershipCache.get(cacheKey)
  if (cached && cached.expires > Date.now()) {
    return cached.role
  }

  // If not in cache or expired, query the database
  try {
    const membership = await db
      .select({ role: workspaceMember.role })
      .from(workspaceMember)
      .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)))
      .then((rows) => rows[0])

    if (!membership) {
      return null
    }

    // Cache the result
    workspaceMembershipCache.set(cacheKey, {
      role: membership.role,
      expires: Date.now() + CACHE_TTL,
    })

    return membership.role
  } catch (error) {
    logger.error(`Error verifying workspace membership for ${userId} in ${workspaceId}:`, error)
    return null
  }
}

export async function GET(request: Request) {
  const requestId = crypto.randomUUID().slice(0, 8)
  const startTime = Date.now()
  const url = new URL(request.url)
  const workspaceId = url.searchParams.get('workspaceId')

  try {
    // Get the session directly in the API route
    const session = await getSession()
    if (!session?.user?.id) {
      logger.warn(`[${requestId}] Unauthorized workflow access attempt`)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const userId = session.user.id

    // If workspaceId is provided, verify it exists and user is a member
    if (workspaceId) {
      // Check workspace exists first
      const workspaceExists = await db
        .select({ id: workspace.id })
        .from(workspace)
        .where(eq(workspace.id, workspaceId))
        .then((rows) => rows.length > 0)

      if (!workspaceExists) {
        logger.warn(
          `[${requestId}] Attempt to fetch workflows for non-existent workspace: ${workspaceId}`
        )
        return NextResponse.json(
          { error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' },
          { status: 404 }
        )
      }

      // Verify the user is a member of the workspace using our optimized function
      const userRole = await verifyWorkspaceMembership(userId, workspaceId)

      if (!userRole) {
        logger.warn(
          `[${requestId}] User ${userId} attempted to access workspace ${workspaceId} without membership`
        )
        return NextResponse.json(
          { error: 'Access denied to this workspace', code: 'WORKSPACE_ACCESS_DENIED' },
          { status: 403 }
        )
      }

      // Migrate any orphaned workflows to this workspace (in background)
      migrateOrphanedWorkflows(userId, workspaceId).catch((error) => {
        logger.error(`[${requestId}] Error migrating orphaned workflows:`, error)
      })
    }

    // Fetch workflows for the user
    let workflows

    if (workspaceId) {
      // Filter by workspace ID only, not user ID
      // This allows sharing workflows across workspace members
      workflows = await db.select().from(workflow).where(eq(workflow.workspaceId, workspaceId))
    } else {
      // Filter by user ID only, including workflows without workspace IDs
      workflows = await db.select().from(workflow).where(eq(workflow.userId, userId))
    }

    const elapsed = Date.now() - startTime

    // Return the workflows
    return NextResponse.json({ data: workflows }, { status: 200 })
  } catch (error: any) {
    const elapsed = Date.now() - startTime
    logger.error(`[${requestId}] Workflow fetch error after ${elapsed}ms`, error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// Helper function to migrate orphaned workflows to a workspace
async function migrateOrphanedWorkflows(userId: string, workspaceId: string) {
  try {
    // Find workflows without workspace IDs for this user
    const orphanedWorkflows = await db
      .select({ id: workflow.id })
      .from(workflow)
      .where(and(eq(workflow.userId, userId), isNull(workflow.workspaceId)))

    if (orphanedWorkflows.length === 0) {
      return // No orphaned workflows to migrate
    }

    logger.info(
      `Migrating ${orphanedWorkflows.length} orphaned workflows to workspace ${workspaceId}`
    )

    // Update workflows in batch if possible
    try {
      // Batch update all orphaned workflows
      await db
        .update(workflow)
        .set({
          workspaceId: workspaceId,
          updatedAt: new Date(),
        })
        .where(and(eq(workflow.userId, userId), isNull(workflow.workspaceId)))

      logger.info(
        `Successfully migrated ${orphanedWorkflows.length} workflows to workspace ${workspaceId}`
      )
    } catch (batchError) {
      logger.warn('Batch migration failed, falling back to individual updates:', batchError)

      // Fallback to individual updates if batch update fails
      for (const { id } of orphanedWorkflows) {
        try {
          await db
            .update(workflow)
            .set({
              workspaceId: workspaceId,
              updatedAt: new Date(),
            })
            .where(eq(workflow.id, id))
        } catch (updateError) {
          logger.error(`Failed to migrate workflow ${id}:`, updateError)
        }
      }
    }
  } catch (error) {
    logger.error('Error migrating orphaned workflows:', error)
    // Continue execution even if migration fails
  }
}

export async function POST(req: NextRequest) {
  const requestId = crypto.randomUUID().slice(0, 8)
  const startTime = Date.now()

  try {
    const session = await getSession()
    if (!session?.user?.id) {
      logger.warn(`[${requestId}] Unauthorized workflow sync attempt`)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()

    try {
      const { workflows: clientWorkflows, workspaceId } = SyncPayloadSchema.parse(body)

      // CRITICAL SAFEGUARD: Prevent wiping out existing workflows
      // If client is sending empty workflows object, first check if user has existing workflows
      if (Object.keys(clientWorkflows).length === 0) {
        let existingWorkflows

        if (workspaceId) {
          existingWorkflows = await db
            .select({ id: workflow.id })
            .from(workflow)
            .where(eq(workflow.workspaceId, workspaceId))
            .limit(1)
        } else {
          existingWorkflows = await db
            .select({ id: workflow.id })
            .from(workflow)
            .where(eq(workflow.userId, session.user.id))
            .limit(1)
        }

        // If user has existing workflows, but client sends empty, reject the sync
        if (existingWorkflows.length > 0) {
          logger.warn(
            `[${requestId}] Prevented data loss: Client attempted to sync empty workflows while DB has workflows in workspace ${workspaceId || 'default'}`
          )
          return NextResponse.json(
            {
              error: 'Sync rejected to prevent data loss',
              message: 'Client sent empty workflows, but user has existing workflows in database',
            },
            { status: 409 }
          )
        }
      }

      // Validate workspace membership and permissions
      let userRole: string | null = null

      if (workspaceId) {
        const workspaceExists = await db
          .select({ id: workspace.id })
          .from(workspace)
          .where(eq(workspace.id, workspaceId))
          .then((rows) => rows.length > 0)

        if (!workspaceExists) {
          logger.warn(
            `[${requestId}] Attempt to sync workflows to non-existent workspace: ${workspaceId}`
          )
          return NextResponse.json(
            {
              error: 'Workspace not found',
              code: 'WORKSPACE_NOT_FOUND',
            },
            { status: 404 }
          )
        }

        // Verify the user is a member of the workspace using our optimized function
        userRole = await verifyWorkspaceMembership(session.user.id, workspaceId)

        if (!userRole) {
          logger.warn(
            `[${requestId}] User ${session.user.id} attempted to sync to workspace ${workspaceId} without membership`
          )
          return NextResponse.json(
            { error: 'Access denied to this workspace', code: 'WORKSPACE_ACCESS_DENIED' },
            { status: 403 }
          )
        }
      }

      // Get all workflows for the workspace from the database
      // If workspaceId is provided, only get workflows for that workspace
      let dbWorkflows

      if (workspaceId) {
        dbWorkflows = await db.select().from(workflow).where(eq(workflow.workspaceId, workspaceId))
      } else {
        dbWorkflows = await db.select().from(workflow).where(eq(workflow.userId, session.user.id))
      }

      const now = new Date()
      const operations: Promise<any>[] = []

      // Create a map of DB workflows for easier lookup
      const dbWorkflowMap = new Map(dbWorkflows.map((w) => [w.id, w]))
      const processedIds = new Set<string>()

      // Process client workflows
      for (const [id, clientWorkflow] of Object.entries(clientWorkflows)) {
        processedIds.add(id)
        const dbWorkflow = dbWorkflowMap.get(id)

        // Handle legacy published workflows migration (only if state is provided)
        // If client workflow has isPublished but no marketplaceData, create marketplaceData with owner status
        if (clientWorkflow.state?.isPublished && !clientWorkflow.marketplaceData) {
          clientWorkflow.marketplaceData = { id: clientWorkflow.id, status: 'owner' }
        }

        // Ensure the workflow has the correct workspaceId
        const effectiveWorkspaceId = clientWorkflow.workspaceId || workspaceId

        // Save to normalized tables for all workflows (hybrid approach)
        const normalizedResult = await saveWorkflowToNormalizedTables(id, {
          blocks: clientWorkflow.state.blocks || {},
          edges: clientWorkflow.state.edges || [],
          loops: clientWorkflow.state.loops || {},
          parallels: clientWorkflow.state.parallels || {},
          lastSaved: clientWorkflow.state.lastSaved,
          isDeployed: clientWorkflow.state.isDeployed,
          deployedAt: clientWorkflow.state.deployedAt,
          deploymentStatuses: (clientWorkflow.state as any).deploymentStatuses || {},
          hasActiveSchedule: (clientWorkflow.state as any).hasActiveSchedule,
          hasActiveWebhook: (clientWorkflow.state as any).hasActiveWebhook,
        })

        // Use the JSON blob from normalized save for compatibility, or fallback to original state
        const stateToSave =
          normalizedResult.success && normalizedResult.jsonBlob
            ? normalizedResult.jsonBlob
            : clientWorkflow.state

        if (normalizedResult.success) {
          logger.info(`[${requestId}] Saved workflow ${id} to normalized tables`)
        } else {
          logger.warn(
            `[${requestId}] Failed to save workflow ${id} to normalized tables: ${normalizedResult.error}`
          )
        }

        if (!dbWorkflow) {
          // New workflow - create (state is required by schema)
          operations.push(
            db.insert(workflow).values({
              id: clientWorkflow.id,
              userId: session.user.id,
              workspaceId: effectiveWorkspaceId,
              folderId: clientWorkflow.folderId || null,
              name: clientWorkflow.name,
              description: clientWorkflow.description,
              color: clientWorkflow.color,
              state: stateToSave,
              marketplaceData: clientWorkflow.marketplaceData || null,
              // Include deployment status from client state
              isDeployed: clientWorkflow.state.isDeployed || false,
              deployedAt: clientWorkflow.state.deployedAt || null,
              // deployedState is null for new workflows - only set during deployment
              deployedState: null,
              lastSynced: now,
              createdAt: now,
              updatedAt: now,
            })
          )
        } else {
          // Check if user has permission to update this workflow
          const canUpdate =
            dbWorkflow.userId === session.user.id ||
            (workspaceId && (userRole === 'owner' || userRole === 'admin' || userRole === 'member'))

          if (!canUpdate) {
            logger.warn(
              `[${requestId}] User ${session.user.id} attempted to update workflow ${id} without permission`
            )
            continue // Skip this workflow update and move to the next one
          }

          // For existing workflows, determine what needs updating
          let needsUpdate = false
          const updateData: any = {}

          // Check metadata changes
          if (dbWorkflow.name !== clientWorkflow.name) {
            updateData.name = clientWorkflow.name
            needsUpdate = true
          }
          if (dbWorkflow.description !== clientWorkflow.description) {
            updateData.description = clientWorkflow.description
            needsUpdate = true
          }
          if (dbWorkflow.color !== clientWorkflow.color) {
            updateData.color = clientWorkflow.color
            needsUpdate = true
          }
          if (dbWorkflow.workspaceId !== effectiveWorkspaceId) {
            updateData.workspaceId = effectiveWorkspaceId
            needsUpdate = true
          }
          if (dbWorkflow.folderId !== (clientWorkflow.folderId || null)) {
            updateData.folderId = clientWorkflow.folderId || null
            needsUpdate = true
          }
          if (
            JSON.stringify(dbWorkflow.marketplaceData) !==
            JSON.stringify(clientWorkflow.marketplaceData)
          ) {
            updateData.marketplaceData = clientWorkflow.marketplaceData || null
            needsUpdate = true
          }

          // Always update state since we only sync the active workflow with valid state
          if (JSON.stringify(dbWorkflow.state) !== JSON.stringify(stateToSave)) {
            updateData.state = stateToSave
            needsUpdate = true
          }

          // Check deployment status changes - ensure dual-write consistency
          const clientIsDeployed = clientWorkflow.state.isDeployed || false
          const clientDeployedAt = clientWorkflow.state.deployedAt || null

          if (dbWorkflow.isDeployed !== clientIsDeployed) {
            updateData.isDeployed = clientIsDeployed
            needsUpdate = true
          }

          // Handle deployedAt comparison (convert to comparable format)
          const dbDeployedAtTime = dbWorkflow.deployedAt
            ? new Date(dbWorkflow.deployedAt).getTime()
            : null
          const clientDeployedAtTime = clientDeployedAt
            ? new Date(clientDeployedAt).getTime()
            : null

          if (dbDeployedAtTime !== clientDeployedAtTime) {
            updateData.deployedAt = clientDeployedAt
            needsUpdate = true
          }

          // CRITICAL: Always preserve deployedState - it should only be modified by deploy/undeploy operations
          // The sync operation should never touch deployedState to prevent data loss
          // Note: We don't add deployedState to updateData because we want to preserve the existing value

          if (needsUpdate) {
            updateData.lastSynced = now
            updateData.updatedAt = now

            operations.push(db.update(workflow).set(updateData).where(eq(workflow.id, id)))
          }
        }
      }

      // NOTE: We don't delete workflows here since we're only syncing the active workflow
      // Other workflows remain untouched in the database

      // Execute all operations in parallel
      await Promise.all(operations)

      const elapsed = Date.now() - startTime

      return NextResponse.json({
        success: true,
        stats: {
          elapsed,
          operations: operations.length,
          workflows: Object.keys(clientWorkflows).length,
        },
      })
    } catch (validationError) {
      if (validationError instanceof z.ZodError) {
        logger.warn(`[${requestId}] Invalid workflow data`, {
          errors: validationError.errors,
        })
        return NextResponse.json(
          { error: 'Invalid request data', details: validationError.errors },
          { status: 400 }
        )
      }
      throw validationError
    }
  } catch (error) {
    const elapsed = Date.now() - startTime
    logger.error(`[${requestId}] Workflow sync error after ${elapsed}ms`, error)
    return NextResponse.json({ error: 'Workflow sync failed' }, { status: 500 })
  }
}
