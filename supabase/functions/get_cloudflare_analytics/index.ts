// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { getTenantId } from "../_shared/auth.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type TopRoute = {
  path_prefix: string;
  request_count: number;
  success_count: number;
  error_count: number;
  total_volume?: string;
};

type RecentEvent = {
  id: string;
  type: string;
  message: string;
  timestamp: number;
  route_id?: string;
  route_path?: string;
};

type CloudflareAnalyticsResponse = {
  top_routes: TopRoute[];
  recent_events: RecentEvent[];
  error?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  try {
    const tenantId = await getTenantId(req);
    const body = await req.json().catch(() => ({}));
    const timeRange = body?.time_range || "24h";

    // Get Supabase service client
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Supabase configuration missing");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });

    // Fetch routes for this tenant
    const { data: routes, error: routesError } = await supabase
      .from("routes")
      .select("id, path_prefix")
      .eq("tenant_id", tenantId);

    if (routesError) {
      throw new Error(`Failed to fetch routes: ${routesError.message}`);
    }

    // For now, return minimal overview data from the events table
    // In a full implementation, you would:
    // 1. Query Cloudflare Analytics API (GraphQL or REST)
    // 2. Use Workers Analytics Engine
    // 3. Query Cloudflare Logs API

    // Calculate time range
    const now = Date.now();
    let startTime: number;
    switch (timeRange) {
      case "1h":
        startTime = now - 60 * 60 * 1000;
        break;
      case "24h":
        startTime = now - 24 * 60 * 60 * 1000;
        break;
      case "7d":
        startTime = now - 7 * 24 * 60 * 60 * 1000;
        break;
      default:
        startTime = now - 24 * 60 * 60 * 1000;
    }

    // Fetch recent events from events table (if it exists)
    // Note: This assumes you have an events table that tracks route activity
    let recentEvents: RecentEvent[] = [];
    
    try {
      const { data: events, error: eventsError } = await supabase
        .from("events")
        .select("id, kind, data, created_at")
        .eq("tenant_id", tenantId)
        .gte("created_at", new Date(startTime).toISOString())
        .order("created_at", { ascending: false })
        .limit(20);

      if (!eventsError && events) {
        recentEvents = events.map((event) => {
          const eventData = event.data as Record<string, any> || {};
          const routeId = eventData.route_id;
          const route = routes?.find((r) => r.id === routeId);
          return {
            id: event.id,
            type: event.kind || "unknown",
            message: eventData.message || eventData.error || JSON.stringify(eventData),
            timestamp: new Date(event.created_at).getTime(),
            route_id: routeId || undefined,
            route_path: route?.path_prefix || undefined,
          };
        });
      }
    } catch (err) {
      console.warn("Events table not available or error fetching events:", err);
    }

    // Calculate top routes from events
    // In a real implementation, this would come from Cloudflare Analytics
    const routeStats: Record<string, {
      request_count: number;
      success_count: number;
      error_count: number;
    }> = {};

    for (const event of recentEvents) {
      if (event.route_path) {
        if (!routeStats[event.route_path]) {
          routeStats[event.route_path] = {
            request_count: 0,
            success_count: 0,
            error_count: 0,
          };
        }
        routeStats[event.route_path].request_count++;
        if (event.type === "error" || event.type === "failed") {
          routeStats[event.route_path].error_count++;
        } else {
          routeStats[event.route_path].success_count++;
        }
      }
    }

    const topRoutes: TopRoute[] = Object.entries(routeStats)
      .map(([path_prefix, stats]) => ({
        path_prefix,
        request_count: stats.request_count,
        success_count: stats.success_count,
        error_count: stats.error_count,
      }))
      .sort((a, b) => b.request_count - a.request_count)
      .slice(0, 10);

    // If no events, return routes with zero stats
    if (topRoutes.length === 0 && routes) {
      topRoutes.push(
        ...routes.slice(0, 10).map((route) => ({
          path_prefix: route.path_prefix,
          request_count: 0,
          success_count: 0,
          error_count: 0,
        }))
      );
    }

    const response: CloudflareAnalyticsResponse = {
      top_routes: topRoutes,
      recent_events: recentEvents.slice(0, 20),
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("get_cloudflare_analytics error:", error);
    return new Response(
      JSON.stringify({
        top_routes: [],
        recent_events: [],
        error: error instanceof Error ? error.message : "Internal server error",
      } as CloudflareAnalyticsResponse),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

