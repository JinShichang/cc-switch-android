package app.ccswitch.android;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Set;

/** Independently implemented from the user-supplied agentrouter filter v2 contract. */
public final class HistoryFilter {
    private static final Set<String> PORTABLE = Set.of("message", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output");
    public static final class Failure extends Exception {
        public final int status;
        public final String code;
        public Failure(int status, String code, String message) { super(message); this.status=status; this.code=code; }
    }
    public record Result(JSONObject body, int reasoning, int ids) {}
    private static boolean truthy(Object value) {
        if(value==null||value==JSONObject.NULL||Boolean.FALSE.equals(value))return false;
        if(value instanceof Number n)return n.doubleValue()!=0;
        return !(value instanceof String s)||!s.isEmpty();
    }
    private static Failure blocked(String code) { return new Failure(409,code,"历史含跨服务商无法复用的响应引用或加密压缩上下文。请用文本摘要开启新会话；历史未被静默丢弃。"); }
    public static Result filter(JSONObject input) throws Exception {
        if(truthy(input.opt("previous_response_id"))||truthy(input.opt("conversation")))throw blocked("response_reference_not_portable");
        if(input.has("include")&&!(input.opt("include") instanceof JSONArray))throw new Failure(400,"invalid_include","include 必须是数组。");
        if(input.has("input")&&!(input.opt("input") instanceof JSONArray)&&!(input.opt("input") instanceof String))throw new Failure(400,"invalid_input","input 必须是字符串或数组。");
        JSONArray context=input.optJSONArray("context_management");
        if(context!=null)for(int i=0;i<context.length();i++)if(context.optJSONObject(i)!=null&&"compaction".equals(context.getJSONObject(i).optString("type")))throw blocked("encrypted_compaction_disabled");
        JSONObject out=new JSONObject(input.toString());out.put("store",false);
        JSONArray include=out.optJSONArray("include");if(include!=null){JSONArray next=new JSONArray();for(int i=0;i<include.length();i++)if(!"reasoning.encrypted_content".equals(include.get(i)))next.put(include.get(i));out.put("include",next);}
        int reasoning=0,ids=0;
        JSONArray items=out.optJSONArray("input");if(items!=null){JSONArray next=new JSONArray();for(int i=0;i<items.length();i++){
            Object raw=items.get(i);if(raw instanceof JSONObject item){String type=item.optString("type");
                if(type.equals("reasoning")){reasoning++;continue;}
                if(type.equals("compaction")||type.equals("item_reference")||truthy(item.opt("encrypted_content")))throw blocked("encrypted_context_not_portable");
                boolean portable=PORTABLE.contains(type)||(!item.has("type")&&item.opt("role") instanceof String&&item.has("content"));
                if(portable&&item.has("id")){item.remove("id");ids++;}
            }next.put(raw);
        }out.put("input",next);}
        return new Result(out,reasoning,ids);
    }
}
