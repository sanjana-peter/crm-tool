export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      activities: {
        Row: {
          activity_type: string
          actor_id: string | null
          contact_id: string | null
          created_at: string
          description: string | null
          id: string
          lead_id: string
          metadata: Json
          org_id: string
          title: string
        }
        Insert: {
          activity_type: string
          actor_id?: string | null
          contact_id?: string | null
          created_at?: string
          description?: string | null
          id?: string
          lead_id: string
          metadata?: Json
          org_id: string
          title: string
        }
        Update: {
          activity_type?: string
          actor_id?: string | null
          contact_id?: string | null
          created_at?: string
          description?: string | null
          id?: string
          lead_id?: string
          metadata?: Json
          org_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "activities_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_org_contact_fkey"
            columns: ["org_id", "contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "activities_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_org_lead_fkey"
            columns: ["org_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      assignment_rotation: {
        Row: {
          last_user_id: string | null
          org_id: string
          updated_at: string
        }
        Insert: {
          last_user_id?: string | null
          org_id: string
          updated_at?: string
        }
        Update: {
          last_user_id?: string | null
          org_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "assignment_rotation_last_user_id_fkey"
            columns: ["last_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_rotation_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_events: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string
          id: string
          metadata: Json
          org_id: string
          request_id: string | null
          summary: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: string
          metadata?: Json
          org_id: string
          request_id?: string | null
          summary: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
          metadata?: Json
          org_id?: string
          request_id?: string | null
          summary?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      calendar_connections: {
        Row: {
          account_email: string
          calendar_id: string
          connected_at: string
          connected_by: string | null
          created_at: string
          id: string
          last_error: string | null
          last_error_at: string | null
          org_id: string
          provider: string
          scopes: string[]
          updated_at: string
          user_id: string | null
        }
        Insert: {
          account_email: string
          calendar_id?: string
          connected_at?: string
          connected_by?: string | null
          created_at?: string
          id?: string
          last_error?: string | null
          last_error_at?: string | null
          org_id: string
          provider: string
          scopes?: string[]
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          account_email?: string
          calendar_id?: string
          connected_at?: string
          connected_by?: string | null
          created_at?: string
          id?: string
          last_error?: string | null
          last_error_at?: string | null
          org_id?: string
          provider?: string
          scopes?: string[]
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "calendar_connections_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calendar_connections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calendar_connections_org_member_fkey"
            columns: ["org_id", "user_id"]
            isOneToOne: false
            referencedRelation: "organization_members"
            referencedColumns: ["org_id", "user_id"]
          },
        ]
      }
      calendar_tokens: {
        Row: {
          connection_id: string
          org_id: string
          refresh_token: string
          updated_at: string
        }
        Insert: {
          connection_id: string
          org_id: string
          refresh_token: string
          updated_at?: string
        }
        Update: {
          connection_id?: string
          org_id?: string
          refresh_token?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_tokens_connection_fkey"
            columns: ["org_id", "connection_id"]
            isOneToOne: false
            referencedRelation: "calendar_connections"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "calendar_tokens_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      call_logs: {
        Row: {
          called_at: string
          caller_id: string | null
          contact_id: string
          created_at: string
          duration_seconds: number | null
          id: string
          lead_id: string
          notes: string | null
          org_id: string
          outcome: string
        }
        Insert: {
          called_at?: string
          caller_id?: string | null
          contact_id: string
          created_at?: string
          duration_seconds?: number | null
          id?: string
          lead_id: string
          notes?: string | null
          org_id: string
          outcome: string
        }
        Update: {
          called_at?: string
          caller_id?: string | null
          contact_id?: string
          created_at?: string
          duration_seconds?: number | null
          id?: string
          lead_id?: string
          notes?: string | null
          org_id?: string
          outcome?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_logs_caller_id_fkey"
            columns: ["caller_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_logs_org_id_caller_id_fkey"
            columns: ["org_id", "caller_id"]
            isOneToOne: false
            referencedRelation: "organization_members"
            referencedColumns: ["org_id", "user_id"]
          },
          {
            foreignKeyName: "call_logs_org_id_contact_id_fkey"
            columns: ["org_id", "contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "call_logs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_logs_org_id_lead_id_fkey"
            columns: ["org_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      contacts: {
        Row: {
          additional_phone: string | null
          additional_phone_normalized: string | null
          created_at: string
          created_by: string | null
          email: string | null
          email_normalized: string | null
          first_name: string
          id: string
          last_name: string | null
          notes: string | null
          org_id: string
          phone: string | null
          phone_normalized: string | null
          source: string
          source_detail: string | null
          tags: string[]
          updated_at: string
          whatsapp_consent_at: string | null
          whatsapp_consent_source: string | null
          whatsapp_consent_status: string
        }
        Insert: {
          additional_phone?: string | null
          additional_phone_normalized?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          email_normalized?: string | null
          first_name: string
          id?: string
          last_name?: string | null
          notes?: string | null
          org_id: string
          phone?: string | null
          phone_normalized?: string | null
          source?: string
          source_detail?: string | null
          tags?: string[]
          updated_at?: string
          whatsapp_consent_at?: string | null
          whatsapp_consent_source?: string | null
          whatsapp_consent_status?: string
        }
        Update: {
          additional_phone?: string | null
          additional_phone_normalized?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          email_normalized?: string | null
          first_name?: string
          id?: string
          last_name?: string | null
          notes?: string | null
          org_id?: string
          phone?: string | null
          phone_normalized?: string | null
          source?: string
          source_detail?: string | null
          tags?: string[]
          updated_at?: string
          whatsapp_consent_at?: string | null
          whatsapp_consent_source?: string | null
          whatsapp_consent_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          channel: string
          contact_id: string
          created_at: string
          id: string
          last_inbound_at: string | null
          last_message_at: string | null
          org_id: string
          updated_at: string
        }
        Insert: {
          channel?: string
          contact_id: string
          created_at?: string
          id?: string
          last_inbound_at?: string | null
          last_message_at?: string | null
          org_id: string
          updated_at?: string
        }
        Update: {
          channel?: string
          contact_id?: string
          created_at?: string
          id?: string
          last_inbound_at?: string | null
          last_message_at?: string | null
          org_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_org_id_contact_id_fkey"
            columns: ["org_id", "contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "conversations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      followups: {
        Row: {
          assigned_to: string | null
          completed_at: string | null
          created_at: string
          created_by: string | null
          description: string
          due_date: string
          due_time: string | null
          id: string
          lead_id: string
          org_id: string
          status: string
          type: string
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          description: string
          due_date: string
          due_time?: string | null
          id?: string
          lead_id: string
          org_id: string
          status?: string
          type?: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          description?: string
          due_date?: string
          due_time?: string | null
          id?: string
          lead_id?: string
          org_id?: string
          status?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "followups_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "followups_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "followups_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "followups_org_assignee_fkey"
            columns: ["org_id", "assigned_to"]
            isOneToOne: false
            referencedRelation: "organization_members"
            referencedColumns: ["org_id", "user_id"]
          },
          {
            foreignKeyName: "followups_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "followups_org_lead_fkey"
            columns: ["org_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      integration_health: {
        Row: {
          last_error: string | null
          last_error_at: string | null
          last_success_at: string | null
          org_id: string
          provider: string
          status: string
          updated_at: string
        }
        Insert: {
          last_error?: string | null
          last_error_at?: string | null
          last_success_at?: string | null
          org_id: string
          provider: string
          status: string
          updated_at?: string
        }
        Update: {
          last_error?: string | null
          last_error_at?: string | null
          last_success_at?: string | null
          org_id?: string
          provider?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "integration_health_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_inquiries: {
        Row: {
          contact_id: string
          created_at: string
          created_opportunity: boolean
          external_id: string | null
          external_provider: string | null
          id: string
          lead_id: string
          org_id: string
          source: string
        }
        Insert: {
          contact_id: string
          created_at?: string
          created_opportunity?: boolean
          external_id?: string | null
          external_provider?: string | null
          id?: string
          lead_id: string
          org_id: string
          source: string
        }
        Update: {
          contact_id?: string
          created_at?: string
          created_opportunity?: boolean
          external_id?: string | null
          external_provider?: string | null
          id?: string
          lead_id?: string
          org_id?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_inquiries_org_id_contact_id_fkey"
            columns: ["org_id", "contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "lead_inquiries_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_inquiries_org_id_lead_id_fkey"
            columns: ["org_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      lead_statuses: {
        Row: {
          created_at: string
          id: string
          is_default: boolean
          is_lost: boolean
          is_won: boolean
          key: string
          label: string
          org_id: string
          pipeline_id: string
          sort_order: number
        }
        Insert: {
          created_at?: string
          id?: string
          is_default?: boolean
          is_lost?: boolean
          is_won?: boolean
          key: string
          label: string
          org_id: string
          pipeline_id: string
          sort_order?: number
        }
        Update: {
          created_at?: string
          id?: string
          is_default?: boolean
          is_lost?: boolean
          is_won?: boolean
          key?: string
          label?: string
          org_id?: string
          pipeline_id?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "lead_statuses_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_statuses_org_pipeline_fkey"
            columns: ["org_id", "pipeline_id"]
            isOneToOne: false
            referencedRelation: "pipelines"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "lead_statuses_pipeline_id_fkey"
            columns: ["pipeline_id"]
            isOneToOne: false
            referencedRelation: "pipelines"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          assigned_to: string | null
          closed_at: string | null
          contact_id: string
          created_at: string
          created_by: string | null
          email: string | null
          external_id: string | null
          external_provider: string | null
          first_contacted_at: string | null
          first_name: string
          id: string
          last_name: string | null
          lost_reason: string | null
          next_action_at: string | null
          org_id: string
          phone: string | null
          pipeline_id: string
          priority: string
          source: string
          status_id: string
          updated_at: string
          value: number | null
        }
        Insert: {
          assigned_to?: string | null
          closed_at?: string | null
          contact_id: string
          created_at?: string
          created_by?: string | null
          email?: string | null
          external_id?: string | null
          external_provider?: string | null
          first_contacted_at?: string | null
          first_name: string
          id?: string
          last_name?: string | null
          lost_reason?: string | null
          next_action_at?: string | null
          org_id: string
          phone?: string | null
          pipeline_id: string
          priority?: string
          source?: string
          status_id: string
          updated_at?: string
          value?: number | null
        }
        Update: {
          assigned_to?: string | null
          closed_at?: string | null
          contact_id?: string
          created_at?: string
          created_by?: string | null
          email?: string | null
          external_id?: string | null
          external_provider?: string | null
          first_contacted_at?: string | null
          first_name?: string
          id?: string
          last_name?: string | null
          lost_reason?: string | null
          next_action_at?: string | null
          org_id?: string
          phone?: string | null
          pipeline_id?: string
          priority?: string
          source?: string
          status_id?: string
          updated_at?: string
          value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "leads_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_org_assignee_fkey"
            columns: ["org_id", "assigned_to"]
            isOneToOne: false
            referencedRelation: "organization_members"
            referencedColumns: ["org_id", "user_id"]
          },
          {
            foreignKeyName: "leads_org_contact_fkey"
            columns: ["org_id", "contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "leads_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_org_pipeline_fkey"
            columns: ["org_id", "pipeline_id"]
            isOneToOne: false
            referencedRelation: "pipelines"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "leads_pipeline_stage_fkey"
            columns: ["pipeline_id", "status_id"]
            isOneToOne: false
            referencedRelation: "lead_statuses"
            referencedColumns: ["pipeline_id", "id"]
          },
          {
            foreignKeyName: "leads_status_id_fkey"
            columns: ["status_id"]
            isOneToOne: false
            referencedRelation: "lead_statuses"
            referencedColumns: ["id"]
          },
        ]
      }
      meeting_attendees: {
        Row: {
          created_at: string
          email: string
          id: string
          meeting_id: string
          name: string | null
          org_id: string
          role: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          meeting_id: string
          name?: string | null
          org_id: string
          role?: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          meeting_id?: string
          name?: string | null
          org_id?: string
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "meeting_attendees_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meeting_attendees_org_id_meeting_id_fkey"
            columns: ["org_id", "meeting_id"]
            isOneToOne: false
            referencedRelation: "meetings"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      meetings: {
        Row: {
          calendar_connection_id: string | null
          created_at: string
          created_by: string | null
          external_booking_url: string | null
          external_event_id: string | null
          external_event_url: string | null
          id: string
          lead_id: string
          meeting_url: string | null
          notes: string | null
          org_id: string
          provider: string
          salesperson_id: string | null
          scheduled_end: string | null
          scheduled_start: string
          status: string
          sync_error: string | null
          title: string | null
          updated_at: string
        }
        Insert: {
          calendar_connection_id?: string | null
          created_at?: string
          created_by?: string | null
          external_booking_url?: string | null
          external_event_id?: string | null
          external_event_url?: string | null
          id?: string
          lead_id: string
          meeting_url?: string | null
          notes?: string | null
          org_id: string
          provider?: string
          salesperson_id?: string | null
          scheduled_end?: string | null
          scheduled_start: string
          status?: string
          sync_error?: string | null
          title?: string | null
          updated_at?: string
        }
        Update: {
          calendar_connection_id?: string | null
          created_at?: string
          created_by?: string | null
          external_booking_url?: string | null
          external_event_id?: string | null
          external_event_url?: string | null
          id?: string
          lead_id?: string
          meeting_url?: string | null
          notes?: string | null
          org_id?: string
          provider?: string
          salesperson_id?: string | null
          scheduled_end?: string | null
          scheduled_start?: string
          status?: string
          sync_error?: string | null
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meetings_calendar_connection_fkey"
            columns: ["org_id", "calendar_connection_id"]
            isOneToOne: false
            referencedRelation: "calendar_connections"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "meetings_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetings_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetings_org_lead_fkey"
            columns: ["org_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "meetings_org_salesperson_fkey"
            columns: ["org_id", "salesperson_id"]
            isOneToOne: false
            referencedRelation: "organization_members"
            referencedColumns: ["org_id", "user_id"]
          },
          {
            foreignKeyName: "meetings_salesperson_id_fkey"
            columns: ["salesperson_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      meta_backfill_jobs: {
        Row: {
          created_at: string
          error: string | null
          failed_count: number
          form_id: string
          form_name: string | null
          id: string
          imported_count: number
          next_cursor: string | null
          org_id: string
          skipped_count: number
          started_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          error?: string | null
          failed_count?: number
          form_id: string
          form_name?: string | null
          id?: string
          imported_count?: number
          next_cursor?: string | null
          org_id: string
          skipped_count?: number
          started_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          error?: string | null
          failed_count?: number
          form_id?: string
          form_name?: string | null
          id?: string
          imported_count?: number
          next_cursor?: string | null
          org_id?: string
          skipped_count?: number
          started_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meta_backfill_jobs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meta_backfill_jobs_started_by_fkey"
            columns: ["started_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      meta_connections: {
        Row: {
          connected_at: string
          connected_by: string | null
          created_at: string
          default_assignee_id: string | null
          id: string
          meta_user_id: string
          meta_user_name: string | null
          org_id: string
          scopes: string[]
          token_expires_at: string | null
          updated_at: string
        }
        Insert: {
          connected_at?: string
          connected_by?: string | null
          created_at?: string
          default_assignee_id?: string | null
          id?: string
          meta_user_id: string
          meta_user_name?: string | null
          org_id: string
          scopes?: string[]
          token_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          connected_at?: string
          connected_by?: string | null
          created_at?: string
          default_assignee_id?: string | null
          id?: string
          meta_user_id?: string
          meta_user_name?: string | null
          org_id?: string
          scopes?: string[]
          token_expires_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meta_connections_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meta_connections_default_assignee_id_fkey"
            columns: ["default_assignee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meta_connections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      meta_lead_attribution: {
        Row: {
          ad_id: string | null
          ad_name: string | null
          adset_id: string | null
          adset_name: string | null
          campaign_id: string | null
          campaign_name: string | null
          created_at: string
          field_data: Json
          form_id: string | null
          form_name: string | null
          is_organic: boolean
          lead_id: string
          leadgen_id: string
          meta_created_time: string | null
          org_id: string
          page_id: string | null
          platform: string | null
        }
        Insert: {
          ad_id?: string | null
          ad_name?: string | null
          adset_id?: string | null
          adset_name?: string | null
          campaign_id?: string | null
          campaign_name?: string | null
          created_at?: string
          field_data?: Json
          form_id?: string | null
          form_name?: string | null
          is_organic?: boolean
          lead_id: string
          leadgen_id: string
          meta_created_time?: string | null
          org_id: string
          page_id?: string | null
          platform?: string | null
        }
        Update: {
          ad_id?: string | null
          ad_name?: string | null
          adset_id?: string | null
          adset_name?: string | null
          campaign_id?: string | null
          campaign_name?: string | null
          created_at?: string
          field_data?: Json
          form_id?: string | null
          form_name?: string | null
          is_organic?: boolean
          lead_id?: string
          leadgen_id?: string
          meta_created_time?: string | null
          org_id?: string
          page_id?: string | null
          platform?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "meta_lead_attribution_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: true
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meta_lead_attribution_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meta_lead_attribution_org_lead_fkey"
            columns: ["org_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      meta_lead_forms: {
        Row: {
          created_at: string
          form_id: string
          form_name: string
          id: string
          last_backfilled_at: string | null
          leads_count: number | null
          org_id: string
          page_id: string
          status: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          form_id: string
          form_name: string
          id?: string
          last_backfilled_at?: string | null
          leads_count?: number | null
          org_id: string
          page_id: string
          status?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          form_id?: string
          form_name?: string
          id?: string
          last_backfilled_at?: string | null
          leads_count?: number | null
          org_id?: string
          page_id?: string
          status?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meta_lead_forms_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meta_lead_forms_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "meta_pages"
            referencedColumns: ["page_id"]
          },
        ]
      }
      meta_page_tokens: {
        Row: {
          org_id: string
          page_access_token: string
          page_id: string
          updated_at: string
        }
        Insert: {
          org_id: string
          page_access_token: string
          page_id: string
          updated_at?: string
        }
        Update: {
          org_id?: string
          page_access_token?: string
          page_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meta_page_tokens_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meta_page_tokens_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: true
            referencedRelation: "meta_pages"
            referencedColumns: ["page_id"]
          },
        ]
      }
      meta_pages: {
        Row: {
          created_at: string
          id: string
          instagram_account_id: string | null
          is_active: boolean
          org_id: string
          page_id: string
          page_name: string
          updated_at: string
          webhook_subscribed: boolean
        }
        Insert: {
          created_at?: string
          id?: string
          instagram_account_id?: string | null
          is_active?: boolean
          org_id: string
          page_id: string
          page_name: string
          updated_at?: string
          webhook_subscribed?: boolean
        }
        Update: {
          created_at?: string
          id?: string
          instagram_account_id?: string | null
          is_active?: boolean
          org_id?: string
          page_id?: string
          page_name?: string
          updated_at?: string
          webhook_subscribed?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "meta_pages_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      meta_user_tokens: {
        Row: {
          expires_at: string | null
          org_id: string
          updated_at: string
          user_access_token: string
        }
        Insert: {
          expires_at?: string | null
          org_id: string
          updated_at?: string
          user_access_token: string
        }
        Update: {
          expires_at?: string | null
          org_id?: string
          updated_at?: string
          user_access_token?: string
        }
        Relationships: [
          {
            foreignKeyName: "meta_user_tokens_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      meta_webhook_events: {
        Row: {
          attempts: number
          error: string | null
          form_id: string | null
          id: string
          lead_id: string | null
          leadgen_id: string | null
          org_id: string | null
          page_id: string | null
          payload: Json
          processed_at: string | null
          received_at: string
          signature_valid: boolean
          status: string
        }
        Insert: {
          attempts?: number
          error?: string | null
          form_id?: string | null
          id?: string
          lead_id?: string | null
          leadgen_id?: string | null
          org_id?: string | null
          page_id?: string | null
          payload?: Json
          processed_at?: string | null
          received_at?: string
          signature_valid?: boolean
          status?: string
        }
        Update: {
          attempts?: number
          error?: string | null
          form_id?: string | null
          id?: string
          lead_id?: string | null
          leadgen_id?: string | null
          org_id?: string | null
          page_id?: string | null
          payload?: Json
          processed_at?: string | null
          received_at?: string
          signature_valid?: boolean
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "meta_webhook_events_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meta_webhook_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      notes: {
        Row: {
          author_id: string | null
          content: string
          created_at: string
          id: string
          lead_id: string
          org_id: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          content: string
          created_at?: string
          id?: string
          lead_id: string
          org_id: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          content?: string
          created_at?: string
          id?: string
          lead_id?: string
          org_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "notes_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_org_lead_fkey"
            columns: ["org_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      organization_members: {
        Row: {
          created_at: string
          id: string
          in_rotation: boolean
          is_active: boolean
          org_id: string
          role: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          in_rotation?: boolean
          is_active?: boolean
          org_id: string
          role: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          in_rotation?: boolean
          is_active?: boolean
          org_id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_members_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          calendly_booking_url: string | null
          created_at: string
          currency: string
          default_country: string
          id: string
          lead_assignment_mode: string
          name: string
          slug: string
          timezone: string
          updated_at: string
        }
        Insert: {
          calendly_booking_url?: string | null
          created_at?: string
          currency?: string
          default_country?: string
          id?: string
          lead_assignment_mode?: string
          name: string
          slug: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          calendly_booking_url?: string | null
          created_at?: string
          currency?: string
          default_country?: string
          id?: string
          lead_assignment_mode?: string
          name?: string
          slug?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      pipelines: {
        Row: {
          created_at: string
          id: string
          is_default: boolean
          name: string
          org_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_default?: boolean
          name: string
          org_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_default?: boolean
          name?: string
          org_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pipelines_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string
          full_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email: string
          full_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      rate_limits: {
        Row: {
          count: number
          key: string
          window_start: string
        }
        Insert: {
          count?: number
          key: string
          window_start: string
        }
        Update: {
          count?: number
          key?: string
          window_start?: string
        }
        Relationships: []
      }
      webhook_receipts: {
        Row: {
          attempts: number
          error: string | null
          event_key: string
          id: string
          org_id: string | null
          processed_at: string | null
          provider: string
          received_at: string
          request_id: string | null
          status: string
        }
        Insert: {
          attempts?: number
          error?: string | null
          event_key: string
          id?: string
          org_id?: string | null
          processed_at?: string | null
          provider: string
          received_at?: string
          request_id?: string | null
          status?: string
        }
        Update: {
          attempts?: number
          error?: string | null
          event_key?: string
          id?: string
          org_id?: string | null
          processed_at?: string | null
          provider?: string
          received_at?: string
          request_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_receipts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_available_numbers: {
        Row: {
          business_id: string
          business_name: string | null
          discovered_at: string
          display_phone_number: string | null
          id: string
          org_id: string
          phone_number_id: string
          verified_name: string | null
          waba_id: string
          waba_name: string | null
        }
        Insert: {
          business_id: string
          business_name?: string | null
          discovered_at?: string
          display_phone_number?: string | null
          id?: string
          org_id: string
          phone_number_id: string
          verified_name?: string | null
          waba_id: string
          waba_name?: string | null
        }
        Update: {
          business_id?: string
          business_name?: string | null
          discovered_at?: string
          display_phone_number?: string | null
          id?: string
          org_id?: string
          phone_number_id?: string
          verified_name?: string | null
          waba_id?: string
          waba_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_available_numbers_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_connections: {
        Row: {
          business_id: string | null
          business_name: string | null
          connected_at: string
          connected_by: string | null
          created_at: string
          display_phone_number: string | null
          id: string
          meta_user_id: string
          meta_user_name: string | null
          org_id: string
          phone_number_id: string | null
          scopes: string[]
          token_expires_at: string | null
          updated_at: string
          verified_name: string | null
          waba_id: string | null
          waba_name: string | null
        }
        Insert: {
          business_id?: string | null
          business_name?: string | null
          connected_at?: string
          connected_by?: string | null
          created_at?: string
          display_phone_number?: string | null
          id?: string
          meta_user_id: string
          meta_user_name?: string | null
          org_id: string
          phone_number_id?: string | null
          scopes?: string[]
          token_expires_at?: string | null
          updated_at?: string
          verified_name?: string | null
          waba_id?: string | null
          waba_name?: string | null
        }
        Update: {
          business_id?: string | null
          business_name?: string | null
          connected_at?: string
          connected_by?: string | null
          created_at?: string
          display_phone_number?: string | null
          id?: string
          meta_user_id?: string
          meta_user_name?: string | null
          org_id?: string
          phone_number_id?: string | null
          scopes?: string[]
          token_expires_at?: string | null
          updated_at?: string
          verified_name?: string | null
          waba_id?: string | null
          waba_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_connections_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_connections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_messages: {
        Row: {
          conversation_id: string
          created_at: string
          delivered_at: string | null
          direction: string
          error: string | null
          error_code: string | null
          from_phone: string | null
          id: string
          language: string | null
          lead_id: string
          message_type: string
          org_id: string
          read_at: string | null
          rendered_body: string
          sent_by: string | null
          status: string
          template_id: string | null
          template_name: string | null
          to_phone: string | null
          wa_message_id: string | null
        }
        Insert: {
          conversation_id: string
          created_at?: string
          delivered_at?: string | null
          direction?: string
          error?: string | null
          error_code?: string | null
          from_phone?: string | null
          id?: string
          language?: string | null
          lead_id: string
          message_type?: string
          org_id: string
          read_at?: string | null
          rendered_body: string
          sent_by?: string | null
          status?: string
          template_id?: string | null
          template_name?: string | null
          to_phone?: string | null
          wa_message_id?: string | null
        }
        Update: {
          conversation_id?: string
          created_at?: string
          delivered_at?: string | null
          direction?: string
          error?: string | null
          error_code?: string | null
          from_phone?: string | null
          id?: string
          language?: string | null
          lead_id?: string
          message_type?: string
          org_id?: string
          read_at?: string | null
          rendered_body?: string
          sent_by?: string | null
          status?: string
          template_id?: string | null
          template_name?: string | null
          to_phone?: string | null
          wa_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_messages_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_messages_org_conversation_fkey"
            columns: ["org_id", "conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "whatsapp_messages_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_messages_org_lead_fkey"
            columns: ["org_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "whatsapp_messages_sent_by_fkey"
            columns: ["sent_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_messages_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_templates: {
        Row: {
          body_text: string
          category: string | null
          components: Json
          created_at: string
          footer_text: string | null
          header_text: string | null
          header_type: string | null
          id: string
          language: string
          name: string
          org_id: string
          status: string
          synced_at: string
          template_id: string
          updated_at: string
          variable_count: number
        }
        Insert: {
          body_text?: string
          category?: string | null
          components?: Json
          created_at?: string
          footer_text?: string | null
          header_text?: string | null
          header_type?: string | null
          id?: string
          language: string
          name: string
          org_id: string
          status?: string
          synced_at?: string
          template_id: string
          updated_at?: string
          variable_count?: number
        }
        Update: {
          body_text?: string
          category?: string | null
          components?: Json
          created_at?: string
          footer_text?: string | null
          header_text?: string | null
          header_type?: string | null
          id?: string
          language?: string
          name?: string
          org_id?: string
          status?: string
          synced_at?: string
          template_id?: string
          updated_at?: string
          variable_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_templates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_user_tokens: {
        Row: {
          expires_at: string | null
          org_id: string
          updated_at: string
          user_access_token: string
        }
        Insert: {
          expires_at?: string | null
          org_id: string
          updated_at?: string
          user_access_token: string
        }
        Update: {
          expires_at?: string | null
          org_id?: string
          updated_at?: string
          user_access_token?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_user_tokens_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      can_access_contact: {
        Args: { p_contact: string; p_created: string; p_org: string }
        Returns: boolean
      }
      can_access_lead: {
        Args: { p_assigned: string; p_created: string; p_org: string }
        Returns: boolean
      }
      current_org_id: { Args: never; Returns: string }
      current_org_role: { Args: never; Returns: string }
      dashboard_rep_activity: {
        Args: { p_from: string; p_org: string }
        Returns: {
          calls: number
          email: string
          followups_completed: number
          full_name: string
          meetings_completed: number
          open_leads: number
          overdue_followups: number
          role: string
          uncontacted: number
          user_id: string
        }[]
      }
      dashboard_source_breakdown: {
        Args: { p_from: string; p_org: string }
        Returns: {
          lead_count: number
          source: string
          won_count: number
        }[]
      }
      dashboard_stage_counts: {
        Args: { p_org: string }
        Returns: {
          lead_count: number
          stage_id: string
        }[]
      }
      find_contact_for_capture: {
        Args: {
          p_email_normalized: string
          p_org: string
          p_phone_normalized: string
        }
        Returns: string
      }
      find_open_opportunity_for_capture: {
        Args: { p_contact: string; p_org: string }
        Returns: {
          assigned_to: string
          created_by: string
          lead_id: string
        }[]
      }
      is_org_member: { Args: { target_org: string }; Returns: boolean }
      next_rotation_assignee: { Args: { p_org: string }; Returns: string }
      rate_limit_hit: {
        Args: { p_key: string; p_limit: number; p_window_seconds: number }
        Returns: boolean
      }
      refresh_lead_next_action: { Args: { p_lead: string }; Returns: undefined }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

