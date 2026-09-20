import { createHash } from 'node:crypto';
import type { ClientQuestion, ExampleAnswer, ExampleScores } from '../types.ts';

// Authored demo answers, NOT statements by the portfolio authors or submitted answers.
// Bind each sample to the saved question and source; never attach it to a changed question.
const samples: Record<string, Record<string, { fingerprint: string; answer: string }>> = {
  design: {
    q1: { fingerprint: 'a6016eb37c374ccda4f20104ae64372136a24152e77e5629b74457c694fec2d6', answer: '팬들이 생일을 함께 축하하는 따뜻하고 친근한 분위기를 전하고 싶었습니다. 빵집은 베이커리 제품과 캐릭터를 다양한 굿즈로 확장하기 좋은 소재라고 생각했습니다. 먼저 공통 색과 일러스트 표현을 정한 뒤, 홍보물과 현장 굿즈가 하나의 행사처럼 보이도록 적용하는 데 초점을 맞췄습니다.' },
    q2: { fingerprint: 'c3c1354843f694b3de235f06329b4174938d44bf5cacf9e93cdb321b9a2f61b4', answer: '기여 범위는 콘셉트 정리, 장면 구성, 생성 이미지의 선택과 편집, 최종 영상 구성으로 나누어 설명하겠습니다. 100%라는 표현은 이 제작 범위 안에서 제가 맡은 비중을 뜻하며, 브랜드 자체나 사용 도구까지 직접 만들었다는 의미는 아닙니다. 사용한 외부 자산과 제가 결정한 부분은 별도로 구분하겠습니다.' },
    q3: { fingerprint: '81840edd04af35745a77b60ad8a2062ebbe275e31796b48f8d50a8692271a5d6', answer: '이 답변 예시에서는 실제 집행 광고가 아닌 제안 시안으로 가정하겠습니다. 장면은 제품과 브랜드 분위기를 짧은 시간에 인식시키는 방향으로 구성했습니다. 시안의 목적은 표현 가능성을 보여주는 것이므로, 광고 성과나 실제 소비자 반응이 검증됐다고 설명하지는 않겠습니다.' },
    q4: { fingerprint: 'afbe4852c88a594338715ef6c1aadffed098e5675ddb8a3277161ebf1eb88823', answer: '직접 제시 형식을 결정했다는 가정이라면, 모바일에서 보이는 크기와 맥락을 함께 전달하려고 스마트폰 목업을 선택했다고 설명하겠습니다. 다만 목업 안에서는 세부 표현을 놓칠 수 있어 원본 프레임도 함께 보여주는 편이 좋습니다. 화면 안에 배치한 것만으로 실제 모바일 광고가 집행됐다는 뜻은 아닙니다.' },
    q5: { fingerprint: '6893ba922eccada0921561086905a3de49f459d56e8c449c023acc7e95c07b74', answer: '빵집이라는 콘셉트가 먼저 읽히고, 그다음 캐릭터의 개성이 보이도록 우선순위를 잡겠습니다. 베이커리 형태, 색의 범위, 선의 굵기를 공통 규칙으로 정하고 굿즈별로 크기와 배치를 달리하는 방식입니다. 작은 인쇄물에서는 장식보다 실루엣과 핵심 특징이 유지되는지를 먼저 보겠습니다.' },
    q6: { fingerprint: '93c44dede8ef5d7e3d7a3a7949705abf5f6a6c859b1922eba1ee0d484914689a', answer: '예를 들어 큰 홍보물의 일러스트를 작은 굿즈에 그대로 줄이면 세부 요소가 잘 보이지 않을 수 있습니다. 그런 조정이 필요했다면 선을 단순화하고 글자와 여백을 늘리되, 핵심 색과 캐릭터 특징은 유지하겠습니다. 수정의 기준은 장식의 양보다 실제 크기에서 콘셉트와 정보가 읽히는지입니다.' },
    q7: { fingerprint: '7429f363e7bc531f1de386a543ee36c694bfc8b8c3df447dda3aa638f247de7b', answer: '설명을 듣기 전에도 빵집과 생일 축하라는 분위기를 떠올릴 수 있는지, 여러 굿즈가 같은 행사로 인식되는지를 기준으로 보겠습니다. 디자인의 일관성과 실제 방문자의 반응은 구분해야 합니다. 관찰이나 설문 기록이 없다면 시각적 일관성까지 설명하고, 전달 효과를 확정적인 성과로 말하지 않겠습니다.' },
  },
  marketing: {
    q1: { fingerprint: 'ab0196541a287edbb0abc79efdef1148efb8038eca72e72f15f067b14b67bfeb', answer: '도달 4,487은 해당 인사이트의 측정 범위에서 광고를 본 계정 규모로 읽겠습니다. 성과를 판단하려면 집행 기간, 예산, 타깃, 노출 위치와 광고 목표가 함께 필요합니다. 이 조건이 없는 상태에서는 숫자의 크기만으로 효율이 높다거나 매출에 기여했다고 결론 내리지 않겠습니다.' },
    q2: { fingerprint: '801cf259bdcc8856fecdcb27def3ff1cd4d7a0e9211df3537ade95a5aa41dbe0', answer: '노출은 광고가 표시된 횟수이고, 도달은 광고를 본 계정의 규모이므로 같은 사람이 여러 번 보면 차이가 생깁니다. 인지도 확대가 목표라면 도달과 반복 노출 정도를, 유입이 목표라면 방문이나 클릭과 그 비용을 함께 보겠습니다. 노출 5,063만으로 광고 효율을 판단하지는 않겠습니다.' },
    q3: { fingerprint: 'c1f9e92b45cee93ef8461a85b7f57129fc9517f82ff11b2beb94ec4a971b70aa', answer: '프로필 방문 68은 광고를 본 뒤 채널을 더 알아보려는 행동과 연결해 볼 수 있습니다. 다만 실제 팔로우, 링크 클릭, 구매까지 이어졌는지는 이 지표에 포함되지 않습니다. 채널 유입이 목표라면 방문당 비용과 이후 행동을 함께 확인하고, 이 숫자를 곧바로 전환 성과로 사용하지 않겠습니다.' },
    q4: { fingerprint: '09074f5d6035714ad333b9c921cb80de181e13bd24bab5f92047c7a159d86d52', answer: '기획에 참여한 상황을 가정하면, 스토리 표현을 바꾸고 싶지만 방법을 찾아보기 번거로운 이용자를 타깃으로 설명하겠습니다. 바로 따라 할 수 있고 저장해 두기 좋은 방법을 모으는 방향입니다. 실제 답변에서는 먼저 본인이 맡은 아이디어 제안, 자료 조사, 제작 범위를 구분하고 팀 전체의 일을 개인 성과로 말하지 않아야 합니다.' },
    q5: { fingerprint: '27e217098c906ba5140ec55d7c03c37f6bfef25766cdfb74e466fc31d28c27b6', answer: '해시태그 14,366은 인사이트가 정의한 해시태그 경로의 유입 지표로 읽되, 고유 이용자 수나 팔로워 증가로 바꾸어 해석하지 않겠습니다. 다음 기획에서는 콘텐츠 주제와 태그의 관련성을 살펴보고 저장·프로필 방문 같은 후속 행동도 비교하겠습니다. 유입이 많다는 이유만으로 같은 태그를 반복하지는 않겠습니다.' },
    q6: { fingerprint: '722dac8c3fccd28a4de6f4bd1bdc9d1ae7178e58de6f1095ebb5c0babe141b9d', answer: '도달한 계정 13,826은 해당 게시물이 전달된 계정 범위를 나타내지만, 이들이 모두 목표 고객이거나 콘텐츠를 끝까지 읽었다는 뜻은 아닙니다. 콘텐츠의 역할에 맞춰 저장, 공유, 프로필 방문 등 다음 행동을 함께 보겠습니다. 팔로워 여부나 집계 기간도 확인해야 다른 게시물과 공정하게 비교할 수 있습니다.' },
    q7: { fingerprint: 'e4a8fb30bf279300a292584daaafb219aa14bb2962be3447720e4bde8068ecf3', answer: '집행 기간과 예산, 목표, 타깃, 노출 위치, 집계 방식이 같거나 차이를 설명할 수 있어야 합니다. 예산이 더 큰 광고의 노출이 많은 것만으로 소재가 더 좋다고 판단하기는 어렵습니다. 조건이 다르다면 비용 대비 노출과 목표 행동을 함께 보고, 차이가 소재 효과인지 집행 조건 때문인지 구분하겠습니다.' },
    q8: { fingerprint: '2088ef6cc5c5648fdf530640695fa88cbdf5ed94c07a9d5bdb65ab3ed8a1229f', answer: '팔로우, 프로필 링크 클릭, 웹사이트 방문, 가입이나 구매 같은 후속 행동 데이터가 필요합니다. 외부 페이지로 연결된다면 추적 링크와 전환 이벤트, 기여 기간을 먼저 정하겠습니다. 프로필 방문과 구매가 같은 기간에 늘었다고 해도 자동으로 인과관계를 뜻하지 않으므로 연결 기준을 함께 설명하겠습니다.' },
    q9: { fingerprint: '1e3cf3206fa3b4dc9ad71d3f1e56bbcca413d1e0e969cdfe67cf2df3d0740520', answer: '제가 기준을 정했다는 가정이라면, 많은 이용자에게 콘텐츠를 알리는 것이 목표였기 때문에 도달 수를 우선 봤다고 설명하겠습니다. 다만 도달 1위는 그 비교 범위에서의 확산 성과이지 모든 목표에서 가장 좋은 콘텐츠라는 뜻은 아닙니다. 관심이나 행동 전환을 평가할 때는 저장과 방문 등 다른 지표를 따로 보겠습니다.' },
  },
  coding: {
    q1: { fingerprint: '35d9e5e2d27f5fc2a7887b9701e52959c4a94b903b80b9f69e80c845dd68c0ac', answer: '기존 분석 결과와 원장을 실수로 덮어쓰지 않기 위한 선택입니다. 먼저 중복 경로와 기존 파일을 확인해 오류를 빨리 알리고, 실제 생성 시에는 wx로 파일이 이미 있으면 실패하게 합니다. 사전 확인 이후 다른 프로세스가 파일을 만드는 경쟁 상황도 파일 생성 단계에서 막으려는 구조입니다.' },
    q2: { fingerprint: '0c1320a4a6a604a5b481188a8f95d67f4abe3ec8c2744a5faeaacd9e9fdeeb2d', answer: 'wx로 잠금 파일을 만들어 같은 원장에 동시에 쓰는 작업을 제한하고, 호출 전에 reserve로 비용을 확보한 뒤 실제 사용량을 확인하면 settle로 정산합니다. JSONL 이벤트를 남기면 승인 금액과 사용 이력을 다시 읽을 수 있습니다. 로컬 파일 기반이므로 여러 서버에서 운영하려면 공유 저장소의 트랜잭션이나 별도 작업 큐가 필요합니다.' },
    q3: { fingerprint: 'f69afbc7f42cbb32404e337529dbdaa9276e6416081a75b1d8287c15a168b9bb', answer: '응답 형식에 따라 추론 토큰이 별도 항목에서 빠질 수 있어 출력과 추론을 더한 값만 믿으면 비용을 적게 계산할 수 있습니다. 전체 토큰에서 입력 토큰을 뺀 값도 함께 비교해 더 큰 쪽을 쓰는 방어 로직입니다. 이는 누락을 줄이기 위한 계산이며, 공급자가 보고한 실제 청구 비용과 동일하다고 단정하지는 않습니다.' },
    q4: { fingerprint: '38616e94c748b61706fecf047299c253594f1d569042283ba0154fe78f122b75', answer: '비전 단계는 문서를 읽고 근거를 연결하는 역할, 질문 단계는 그 근거로 질문을 만드는 역할로 나눈 것입니다. Opus에 원본 이미지나 PDF를 다시 주면 앞 단계에서 확인하지 않은 내용을 질문의 전제로 사용할 수 있습니다. 입력을 검증된 근거 JSON으로 제한해 어느 자료에서 질문이 나왔는지 추적하기 쉽게 했습니다.' },
    q5: { fingerprint: '053d181ad776f13705f3dfbbf099969929b597bc77d68ff69a550fb667d9acb9', answer: '여러 요청이 같은 잔액을 보고 동시에 시작하는 상황을 막고, 응답이 나오기 전에도 지출 한도를 보호하려는 설계입니다. 요청을 직렬화하고 최대 비용을 먼저 예약한 뒤 실제 사용량이 확인되면 정산합니다. 다만 최대 컨텍스트 기준 예약은 실제 비용보다 크게 잡힐 수 있으므로 예약액과 실제 지출은 별도 항목으로 보고해야 합니다.' },
    q6: { fingerprint: '4134fe05e69ff097684dfd59a7ce6449ef7daef55d5f8f8851406e85ac0aa803', answer: '가로세로 비율이 크지 않으면 전체 페이지를 쓰고, 긴 페이지는 긴 축을 따라 최대 8개의 겹치는 띠로 나눕니다. 정규화 좌표를 써서 원본 페이지와 연결하고 첫 영역부터 끝 영역까지 포함하게 배치합니다. 8개 상한 때문에 극단적으로 긴 문서에서는 글씨가 여전히 작아질 수 있어, 필요한 영역을 따로 렌더링하고 읽히는지 확인해야 합니다.' },
    q7: { fingerprint: 'b9099f391346737b6d7691beab00a349c346fa83e2a5fae0af3ed1e9f4d902cb', answer: '숫자만 잘라 인용하면 부호나 단위가 빠져 원래 의미가 바뀔 수 있습니다. 예를 들어 음수의 부호가 잘리거나 %p 중 p가 빠지면 서로 다른 주장처럼 보입니다. 원문에서 인용 위치를 찾고 앞뒤 문자까지 확인해 이런 경계 잘림을 막습니다. 애매한 경우에는 더 긴 원문이나 이미지 근거를 확인하는 편이 안전합니다.' },
  },
};

export function exampleAnswers(slug: string, questions: ClientQuestion[]): ExampleAnswer[] {
  return questions.flatMap(q => {
    const sample = samples[slug]?.[q.id];
    const fingerprint = createHash('sha256').update(JSON.stringify([q.prompt, q.quotes, q.projectTitle])).digest('hex');
    return sample?.fingerprint === fingerprint ? [{ questionId: q.id, answer: sample.answer }] : [];
  });
}

// Fixed display fixtures, not AI output or an assessment of the visitor's answers.
// Reuse the exact question fingerprint gate; a changed example must not inherit a score.
export function exampleScores(slug: string, questions: ClientQuestion[]): ExampleScores | null {
  const values: Record<string, number[]> = {
    design: [88, 84, 82, 86, 92, 80, 90],
    marketing: [86, 90, 84, 80, 88, 86, 92, 90, 82],
    coding: [90, 88, 84, 92, 86, 82, 94],
  };
  const items = exampleAnswers(slug, questions).flatMap(a => {
    const score = values[slug]?.[Number(a.questionId.slice(1)) - 1];
    return score === undefined ? [] : [{ questionId: a.questionId, score }];
  });
  if (!items.length || items.length !== questions.length) return null;
  return { overallScore: Math.round(items.reduce((sum, item) => sum + item.score, 0) / items.length), items };
}
