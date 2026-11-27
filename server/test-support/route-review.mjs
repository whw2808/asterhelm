// Fixtures opt in to an independent grant only in tests of an authorized request.
export function approveRoute(input){
  return {reply:'',actions:input.proposals.map(({index,kind,target})=>({
    type:'allow_effect',index,kind,...(target?{target}:{}),evidence:input.currentUser
  }))};
}
