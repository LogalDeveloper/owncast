(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[1774],{57838:function(e,n,t){"use strict";t.d(n,{Z:function(){return o}});var r=t(97685),c=t(67294);function o(){var e=c.useReducer(function(e){return e+1},0);return(0,r.Z)(e,2)[1]}},25378:function(e,n,t){"use strict";var r=t(67294),c=t(57838),o=t(24308);n.Z=function(){var e=!(arguments.length>0)||void 0===arguments[0]||arguments[0],n=(0,r.useRef)({}),t=(0,c.Z)();return(0,r.useEffect)(function(){var r=o.ZP.subscribe(function(r){n.current=r,e&&t()});return function(){return o.ZP.unsubscribe(r)}},[]),n.current}},20550:function(e,n,t){"use strict";t.d(n,{Z:function(){return Z}});var r=t(4942),c=t(87462),o=t(97685),l=t(97937),i=t(94184),a=t.n(i),u=t(98423),s=t(67294),f=t(53124),d=t(98787),v=t(68349),p=function(e,n){var t={};for(var r in e)Object.prototype.hasOwnProperty.call(e,r)&&0>n.indexOf(r)&&(t[r]=e[r]);if(null!=e&&"function"==typeof Object.getOwnPropertySymbols)for(var c=0,r=Object.getOwnPropertySymbols(e);c<r.length;c++)0>n.indexOf(r[c])&&Object.prototype.propertyIsEnumerable.call(e,r[c])&&(t[r[c]]=e[r[c]]);return t},g=function(e,n){var t={};for(var r in e)Object.prototype.hasOwnProperty.call(e,r)&&0>n.indexOf(r)&&(t[r]=e[r]);if(null!=e&&"function"==typeof Object.getOwnPropertySymbols)for(var c=0,r=Object.getOwnPropertySymbols(e);c<r.length;c++)0>n.indexOf(r[c])&&Object.prototype.propertyIsEnumerable.call(e,r[c])&&(t[r[c]]=e[r[c]]);return t},m=new RegExp("^(".concat(d.Y.join("|"),")(-inverse)?$")),h=new RegExp("^(".concat(d.E.join("|"),")$")),b=s.forwardRef(function(e,n){var t,i=e.prefixCls,d=e.className,p=e.style,b=e.children,Z=e.icon,x=e.color,y=e.onClose,E=e.closeIcon,w=e.closable,C=void 0!==w&&w,O=g(e,["prefixCls","className","style","children","icon","color","onClose","closeIcon","closable"]),k=s.useContext(f.E_),j=k.getPrefixCls,P=k.direction,N=s.useState(!0),_=(0,o.Z)(N,2),I=_[0],S=_[1];s.useEffect(function(){"visible"in O&&S(O.visible)},[O.visible]);var T=function(){return!!x&&(m.test(x)||h.test(x))},M=(0,c.Z)({backgroundColor:x&&!T()?x:void 0},p),R=T(),D=j("tag",i),z=a()(D,(t={},(0,r.Z)(t,"".concat(D,"-").concat(x),R),(0,r.Z)(t,"".concat(D,"-has-color"),x&&!R),(0,r.Z)(t,"".concat(D,"-hidden"),!I),(0,r.Z)(t,"".concat(D,"-rtl"),"rtl"===P),t),d),L=function(e){e.stopPropagation(),null==y||y(e),!e.defaultPrevented&&("visible"in O||S(!1))},F="onClick"in O||b&&"a"===b.type,X=(0,u.Z)(O,["visible"]),$=Z||null,G=$?s.createElement(s.Fragment,null,$,s.createElement("span",null,b)):b,K=s.createElement("span",(0,c.Z)({},X,{ref:n,className:z,style:M}),G,C?E?s.createElement("span",{className:"".concat(D,"-close-icon"),onClick:L},E):s.createElement(l.Z,{className:"".concat(D,"-close-icon"),onClick:L}):null);return F?s.createElement(v.Z,null,K):K});b.CheckableTag=function(e){var n,t=e.prefixCls,o=e.className,l=e.checked,i=e.onChange,u=e.onClick,d=p(e,["prefixCls","className","checked","onChange","onClick"]),v=(0,s.useContext(f.E_).getPrefixCls)("tag",t),g=a()(v,(n={},(0,r.Z)(n,"".concat(v,"-checkable"),!0),(0,r.Z)(n,"".concat(v,"-checkable-checked"),l),n),o);return s.createElement("span",(0,c.Z)({},d,{className:g,onClick:function(e){null==i||i(!l),null==u||u(e)}}))};var Z=b},93645:function(e,n,t){"use strict";t.d(n,{u:function(){return c}});var r={ceil:Math.ceil,round:Math.round,floor:Math.floor,trunc:function(e){return e<0?Math.ceil(e):Math.floor(e)}};function c(e){return e?r[e]:r.trunc}},59910:function(e,n,t){"use strict";t.d(n,{Z:function(){return o}});var r=t(19013),c=t(13882);function o(e,n){return(0,c.Z)(2,arguments),(0,r.Z)(e).getTime()-(0,r.Z)(n).getTime()}},11699:function(e,n,t){"use strict";t.d(n,{Z:function(){return l}});var r=t(59910),c=t(13882),o=t(93645);function l(e,n,t){(0,c.Z)(2,arguments);var l=(0,r.Z)(e,n)/1e3;return(0,o.u)(null==t?void 0:t.roundingMethod)(l)}},23426:function(e,n,t){(window.__NEXT_P=window.__NEXT_P||[]).push(["/admin/logs",function(){return t(97525)}])},86177:function(e,n,t){"use strict";t.d(n,{o:function(){return d}});var r=t(85893);t(67294);var c=t(85818),o=t(20550),l=t(54398),i=t(53731),a=t(58091);let{Title:u}=c.default;function s(e,n){let t="black";return"warning"===n.level?t="orange":"error"===n.level&&(t="red"),(0,r.jsx)(o.Z,{color:t,children:e})}function f(e){return(0,r.jsx)(i.Z,{children:e})}let d=e=>{let{logs:n,pageSize:t}=e;if(!(null==n?void 0:n.length))return null;let c=[{title:"Level",dataIndex:"level",key:"level",filters:[{text:"Info",value:"info"},{text:"Warning",value:"warning"},{text:"Error",value:"Error"}],onFilter:(e,n)=>0===n.level.indexOf(e),render:s},{title:"Timestamp",dataIndex:"time",key:"time",render:e=>{let n=new Date(e);return(0,a.Z)(n,"pp P")},sorter:(e,n)=>new Date(e.time).getTime()-new Date(n.time).getTime(),sortDirections:["descend","ascend"],defaultSortOrder:"descend"},{title:"Message",dataIndex:"message",key:"message",render:f}];return(0,r.jsxs)("div",{className:"logs-section",children:[(0,r.jsx)(u,{children:"Logs"}),(0,r.jsx)(l.Z,{size:"middle",dataSource:n,columns:c,rowKey:e=>e.time,pagination:{pageSize:t||20}})]})}},97525:function(e,n,t){"use strict";t.r(n),t.d(n,{default:function(){return a}});var r=t(85893),c=t(67294),o=t(86177),l=t(81453),i=t(34261);function a(){let[e,n]=(0,c.useState)([]),t=async()=>{try{let e=await (0,l.rQ)(l.sG);n(e)}catch(e){console.log("==== error",e)}};return(0,c.useEffect)(()=>{let e=null;return setInterval(t,5e3),t(),e=setInterval(t,5e3),()=>{clearInterval(e)}},[]),(0,r.jsx)(o.o,{logs:e,pageSize:20})}a.getLayout=function(e){return(0,r.jsx)(i.l,{page:e})}},11163:function(e,n,t){e.exports=t(96885)}},function(e){e.O(0,[173,5874,7311,2414,4931,5402,6524,1664,5348,9915,1382,4041,3698,3013,4398,8091,4302,4261,9774,2888,179],function(){return e(e.s=23426)}),_N_E=e.O()}]);